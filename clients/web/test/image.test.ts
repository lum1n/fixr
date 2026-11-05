import { describe, expect, it } from "vitest";
import { prepareImage, type ImageEncoder } from "../src/image.js";
import type { ImageMime } from "../src/wire.js";

type Call = { w: number; h: number; mime: ImageMime; q?: number };

/** Size model: bytes per pixel by format/quality. */
function fakeEncoder(width: number, height: number, bpp: (mime: ImageMime, q?: number) => number) {
  const calls: Call[] = [];
  const enc: ImageEncoder = {
    width,
    height,
    async encode(w, h, mime, q) {
      calls.push({ w, h, mime, ...(q !== undefined ? { q } : {}) });
      return { size: Math.ceil(w * h * bpp(mime, q)), type: mime } as Blob;
    },
  };
  return { enc, calls };
}

describe("image ladder", () => {
  it("downscales to a 2000 px long edge and keeps a PNG that fits", async () => {
    const { enc, calls } = fakeEncoder(4000, 3000, () => 0.1);
    const r = await prepareImage(enc);
    expect(r).toMatchObject({ mime: "image/png", width: 2000, height: 1500 });
    expect(calls).toEqual([{ w: 2000, h: 1500, mime: "image/png" }]);
  });

  it("does not upscale small images", async () => {
    const { enc, calls } = fakeEncoder(800, 600, () => 1);
    await prepareImage(enc);
    expect(calls[0]).toEqual({ w: 800, h: 600, mime: "image/png" });
  });

  it("falls through JPEG 0.9 → 0.5 and takes the first that fits", async () => {
    // 2000×1000 = 2e6 px. PNG 3 B/px; JPEG q*1.2 B/px → 0.9:2.16e6, 0.8:1.92e6 fits.
    const { enc, calls } = fakeEncoder(2000, 1000, (m, q) => (m === "image/png" ? 3 : q! * 1.2));
    const r = await prepareImage(enc);
    expect(r).toMatchObject({ mime: "image/jpeg", quality: 0.8, width: 2000, height: 1000 });
    expect(calls.map((c) => c.q ?? c.mime)).toEqual(["image/png", 0.9, 0.8]);
  });

  it("scales by 0.75 and starts over with PNG when nothing fits", async () => {
    // Fits only once w*h*2 ≤ 2e6 for JPEG 0.5 (bpp 2 at any quality, PNG 10).
    const { enc, calls } = fakeEncoder(2000, 2000, (m) => (m === "image/png" ? 10 : 2));
    const r = await prepareImage(enc);
    const sizes = [...new Set(calls.map((c) => `${c.w}x${c.h}`))];
    expect(sizes).toEqual(["2000x2000", "1500x1500", "1125x1125", "844x844"]);
    expect(calls.filter((c) => c.w === 2000).map((c) => c.q ?? c.mime)).toEqual(["image/png", 0.9, 0.8, 0.7, 0.6, 0.5]);
    expect(r).toMatchObject({ mime: "image/jpeg", quality: 0.9, width: 844, height: 844 });
  });

  it("gives up below 200 px long edge with too_large", async () => {
    const { enc, calls } = fakeEncoder(2000, 1000, () => 1e6);
    expect(await prepareImage(enc)).toEqual({ omitted: "too_large" });
    const longEdges = [...new Set(calls.map((c) => c.w))];
    expect(Math.min(...longEdges)).toBeGreaterThanOrEqual(200);
    expect(Math.round(Math.min(...longEdges) * 0.75)).toBeLessThan(200);
  });

  it("returns too_large for an empty source", async () => {
    expect(await prepareImage(fakeEncoder(0, 0, () => 0).enc)).toEqual({ omitted: "too_large" });
  });
});
