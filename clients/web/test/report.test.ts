import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildReport, formatCreatedAt, isUuidV4, sanitizeExtra, serializeReport, uuidv4 } from "../src/report.js";

const golden = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../spec/fixtures/report.v1.json"), "utf8"));

const fixedInput = {
  id: "0b9f6c1e-3c1a-4d2b-9a57-5f3d2c1b0a99",
  createdAt: new Date("2026-11-05T14:03:12.345Z"),
  prompt: "The Save button is misaligned with Cancel; make them the same height.",
  sdk: { name: "fixr-test", version: "0.1.0" },
  app: { id: "com.example.notes", version: "1.4.2", build: "231" },
  device: { platform: "macos" as const, osVersion: "15.1", model: "Mac15,6", screen: { width: 1512, height: 982, scale: 2 } },
  locale: "en-US",
  context: { screen: "EditorViewController", title: "Untitled", url: "https://notes.example.com/doc/42" },
  screenshotOmittedReason: "user_removed",
  extra: { branch: "main", user_tier: "beta" },
};

describe("report serialization", () => {
  it("equals the golden fixture", () => {
    expect(JSON.parse(serializeReport(buildReport(fixedInput)))).toEqual(golden);
  });

  it("omits unknown optional members instead of writing null", () => {
    const r = buildReport({
      id: fixedInput.id,
      createdAt: fixedInput.createdAt,
      prompt: "x",
      app: { id: "example.com", version: "" },
      device: { platform: "web" },
      context: { title: "" },
      extra: { a: undefined, b: null },
    });
    expect(r).toEqual({
      schema: 1,
      id: fixedInput.id,
      created_at: "2026-11-05T14:03:12Z",
      prompt: "x",
      sdk: { name: "fixr-web", version: "0.1.0" },
      app: { id: "example.com" },
      device: { platform: "web" },
    });
    expect(serializeReport(r)).not.toContain("null");
  });

  it("validates the prompt in Unicode scalar values", () => {
    const base = { ...fixedInput };
    expect(() => buildReport({ ...base, prompt: "   " })).toThrow(RangeError);
    expect(buildReport({ ...base, prompt: "😀".repeat(4000) }).prompt).toHaveLength(8000);
    expect(() => buildReport({ ...base, prompt: "😀".repeat(4001) })).toThrow(RangeError);
  });

  it("formats created_at as whole-second UTC", () => {
    expect(formatCreatedAt(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 999)))).toBe("2026-01-02T03:04:05Z");
  });

  it("generates lowercase v4 ids", () => {
    for (let i = 0; i < 50; i++) expect(isUuidV4(uuidv4())).toBe(true);
  });

  it("clamps extra to 32 string keys", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
    const out = sanitizeExtra({ ["x".repeat(65)]: "dropped", long: "v".repeat(2000), ...many })!;
    expect(Object.keys(out)).toHaveLength(32);
    expect(out.long).toHaveLength(1000);
    expect(out.k0).toBe("0");
    expect(out["x".repeat(65)]).toBeUndefined();
  });
});
