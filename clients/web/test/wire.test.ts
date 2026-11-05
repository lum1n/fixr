// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildReport } from "../src/report.js";
import { buildJsonBody, buildMultipart, classifyStatus, requestHeaders } from "../src/wire.js";

const report = buildReport({
  id: "0b9f6c1e-3c1a-4d2b-9a57-5f3d2c1b0a99",
  createdAt: new Date("2026-11-05T14:03:12Z"),
  prompt: "make it bold",
  app: { id: "example.com" },
  device: { platform: "web" },
});
const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: "image/png" });

interface Part {
  headers: string;
  body: Buffer;
}

async function parts(fd: FormData): Promise<{ contentType: string; parts: Part[] }> {
  const res = new Response(fd);
  const contentType = res.headers.get("content-type")!;
  const buf = Buffer.from(await res.arrayBuffer());
  const boundary = `--${/boundary=(.+)$/.exec(contentType)![1]}`;
  const out: Part[] = [];
  const chunks = buf.toString("latin1").split(boundary).slice(1, -1);
  for (const c of chunks) {
    const s = c.slice(2, -2); // leading CRLF, trailing CRLF
    const i = s.indexOf("\r\n\r\n");
    out.push({ headers: s.slice(0, i), body: Buffer.from(s.slice(i + 4), "latin1") });
  }
  return { contentType, parts: out };
}

describe("multipart body", () => {
  it("has exactly report then screenshot, with the right types and filename", async () => {
    const { contentType, parts: p } = await parts(buildMultipart(report, { blob: png, mime: "image/png" }));
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(p).toHaveLength(2);
    expect(p[0]!.headers).toMatch(/name="report"/);
    expect(p[0]!.headers).toMatch(/Content-Type: application\/json/i);
    expect(JSON.parse(p[0]!.body.toString("utf8"))).toEqual(report);
    expect(JSON.parse(p[0]!.body.toString("utf8")).screenshot).toBeUndefined();
    expect(p[1]!.headers).toMatch(/name="screenshot"; filename="screenshot.png"/);
    expect(p[1]!.headers).toMatch(/Content-Type: image\/png/i);
    expect([...p[1]!.body]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  });

  it("uses screenshot.jpg for JPEG and only the report part without an image", async () => {
    const jpg = await parts(buildMultipart(report, { blob: new Blob([new Uint8Array([1])]), mime: "image/jpeg" }));
    expect(jpg.parts[1]!.headers).toMatch(/filename="screenshot.jpg"/);
    expect(jpg.parts[1]!.headers).toMatch(/Content-Type: image\/jpeg/i);
    const none = await parts(buildMultipart(report));
    expect(none.parts).toHaveLength(1);
  });

  it("JSON fallback carries screenshot {mime, data} as padded base64", async () => {
    const body = JSON.parse(await buildJsonBody(report, { blob: png, mime: "image/png" }));
    expect(body.screenshot).toEqual({ mime: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64") });
    expect(body.screenshot.data).toMatch(/=$/);
    expect(JSON.parse(await buildJsonBody(report))).toEqual(report);
  });

  it("headers carry bearer, idempotency key and SDK id", () => {
    expect(requestHeaders("pk_1", report.id)).toEqual({
      Authorization: "Bearer pk_1",
      "Idempotency-Key": report.id,
      "X-Fixr-SDK": "fixr-web/0.1.0",
    });
    expect(requestHeaders("pk_1", report.id, false)).not.toHaveProperty("X-Fixr-SDK");
  });
});

describe("response classification", () => {
  it.each([
    [201, "delivered"],
    [200, "delivered"],
    [400, "permanent"],
    [401, "permanent"],
    [403, "permanent"],
    [404, "permanent"],
    [409, "permanent"],
    [413, "permanent"],
    [422, "permanent"],
    [408, "retry"],
    [429, "retry"],
    [500, "retry"],
    [502, "retry"],
    [503, "retry"],
    [599, "retry"],
  ])("%i → %s", (status, kind) => {
    expect(classifyStatus(status).kind).toBe(kind);
  });

  it("marks 200 as a duplicate", () => {
    expect(classifyStatus(200)).toEqual({ kind: "delivered", duplicate: true });
    expect(classifyStatus(201)).toEqual({ kind: "delivered", duplicate: false });
  });

  it("reads Retry-After on 429/503 only", () => {
    expect(classifyStatus(429, "120")).toEqual({ kind: "retry", status: 429, retryAfterMs: 120_000 });
    expect(classifyStatus(503, "7")).toEqual({ kind: "retry", status: 503, retryAfterMs: 7_000 });
    expect(classifyStatus(500, "120")).toEqual({ kind: "retry", status: 500 });
  });
});
