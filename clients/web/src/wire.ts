import { SDK_HEADER, SDK_HEADER_VALUE } from "./constants.js";
import { parseRetryAfter } from "./backoff.js";
import type { Report } from "./report.js";

export type ImageMime = "image/png" | "image/jpeg";

export interface Screenshot {
  blob: Blob;
  mime: ImageMime;
}

export function screenshotFilename(mime: ImageMime): string {
  return mime === "image/png" ? "screenshot.png" : "screenshot.jpg";
}

export function requestHeaders(projectKey: string, id: string, sdkHeader = true): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${projectKey}`,
    "Idempotency-Key": id,
  };
  if (sdkHeader) h[SDK_HEADER] = SDK_HEADER_VALUE;
  return h;
}

/**
 * multipart/form-data body: exactly `report` (application/json, no screenshot member)
 * then optional `screenshot` (image/png|image/jpeg, filename screenshot.png|jpg).
 * The report part is a Blob so it carries Content-Type: application/json.
 */
export function buildMultipart(report: Report, screenshot?: Screenshot): FormData {
  const fd = new FormData();
  fd.append("report", new Blob([JSON.stringify(report)], { type: "application/json" }), "report.json");
  if (screenshot) {
    const blob = screenshot.blob.type === screenshot.mime ? screenshot.blob : new Blob([screenshot.blob], { type: screenshot.mime });
    fd.append("screenshot", blob, screenshotFilename(screenshot.mime));
  }
  return fd;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Uint8Array(
    await new Promise<ArrayBuffer>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(blob);
    }),
  );
}

/** application/json body: the report plus `screenshot: {mime, data: base64}` when given. */
export async function buildJsonBody(report: Report, screenshot?: Screenshot): Promise<string> {
  if (!screenshot) return JSON.stringify(report);
  const data = bytesToBase64(await blobBytes(screenshot.blob));
  return JSON.stringify({ ...report, screenshot: { mime: screenshot.mime, data } });
}

export type Outcome =
  | { kind: "delivered"; duplicate: boolean }
  | { kind: "permanent"; status: number }
  | { kind: "retry"; status?: number; retryAfterMs?: number };

/** Map an HTTP status (or a network error) to the client action in wire-format.md. */
export function classifyStatus(status: number, retryAfter?: string | null, nowMs = Date.now()): Outcome {
  if (status === 201) return { kind: "delivered", duplicate: false };
  if (status === 200) return { kind: "delivered", duplicate: true };
  if (status >= 200 && status < 300) return { kind: "delivered", duplicate: false };
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
    const out: Outcome = { kind: "retry", status };
    if (status === 429 || status === 503) {
      const ra = parseRetryAfter(retryAfter, nowMs);
      if (ra !== undefined) out.retryAfterMs = ra;
    }
    return out;
  }
  if (status >= 400 && status < 500) return { kind: "permanent", status };
  // 1xx/3xx (or 0 from an opaque response): not something the Worker sends; try again later.
  return { kind: "retry", status };
}

export function classifyResponse(res: Pick<Response, "status" | "headers">, nowMs = Date.now()): Outcome {
  return classifyStatus(res.status, res.headers.get("retry-after"), nowMs);
}
