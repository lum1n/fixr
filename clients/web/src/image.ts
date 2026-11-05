import { DEFAULT_LIMITS, type Limits } from "./constants.js";
import type { ImageMime, Screenshot } from "./wire.js";

/** Encodes the source scaled to width×height. The only seam the ladder needs; fake it in tests. */
export interface ImageEncoder {
  readonly width: number;
  readonly height: number;
  encode(width: number, height: number, mime: ImageMime, quality?: number): Promise<Blob>;
}

export type LadderResult =
  | (Screenshot & { width: number; height: number; quality?: number })
  | { omitted: "too_large" };

type LadderLimits = Pick<Limits, "maxLongEdge" | "maxImageBytes" | "minLongEdge" | "jpegQualities" | "scaleStep">;

/**
 * Image preparation ladder (wire-format.md):
 * 1. downscale so the long edge ≤ maxLongEdge; 2. PNG, done if ≤ maxImageBytes;
 * 3. JPEG at each quality, first fit wins; 4. ×scaleStep and back to 2.
 * Gives up below minLongEdge → `too_large`.
 */
export async function prepareImage(encoder: ImageEncoder, limits: Partial<LadderLimits> = {}): Promise<LadderResult> {
  const l = { ...DEFAULT_LIMITS, ...limits };
  const { width: w0, height: h0 } = encoder;
  const long0 = Math.max(w0, h0);
  if (!(long0 > 0)) return { omitted: "too_large" };
  let scale = Math.min(1, l.maxLongEdge / long0);
  for (;;) {
    const width = Math.max(1, Math.round(w0 * scale));
    const height = Math.max(1, Math.round(h0 * scale));
    if (Math.max(width, height) < l.minLongEdge) return { omitted: "too_large" };
    const png = await encoder.encode(width, height, "image/png");
    if (png.size <= l.maxImageBytes) return { blob: png, mime: "image/png", width, height };
    for (const quality of l.jpegQualities) {
      const jpg = await encoder.encode(width, height, "image/jpeg", quality);
      if (jpg.size <= l.maxImageBytes) return { blob: jpg, mime: "image/jpeg", width, height, quality };
    }
    scale *= l.scaleStep;
  }
}

export type DrawableSource = CanvasImageSource & { width: number; height: number };

function sourceSize(src: CanvasImageSource): { width: number; height: number } {
  const s = src as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width: number; height: number };
  if (s.naturalWidth) return { width: s.naturalWidth, height: s.naturalHeight ?? 0 };
  if (s.videoWidth) return { width: s.videoWidth, height: s.videoHeight ?? 0 };
  return { width: Number(s.width) || 0, height: Number(s.height) || 0 };
}

function canvasToBlob(c: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))), mime, quality),
  );
}

/** Canvas-backed encoder; OffscreenCanvas where it can encode, else a detached <canvas>. */
export function canvasEncoder(source: CanvasImageSource): ImageEncoder {
  const { width, height } = sourceSize(source);
  return {
    width,
    height,
    async encode(w, h, mime, quality) {
      if (typeof OffscreenCanvas !== "undefined" && "convertToBlob" in OffscreenCanvas.prototype) {
        try {
          const oc = new OffscreenCanvas(w, h);
          const ctx = oc.getContext("2d");
          if (ctx) {
            if (mime === "image/jpeg") {
              ctx.fillStyle = "#fff";
              ctx.fillRect(0, 0, w, h);
            }
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(source, 0, 0, w, h);
            return await oc.convertToBlob(quality === undefined ? { type: mime } : { type: mime, quality });
          }
        } catch {
          /* fall back to a DOM canvas (e.g. source not transferable to a worker-ish canvas) */
        }
      }
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("2d canvas unavailable");
      if (mime === "image/jpeg") {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, 0, 0, w, h);
      return canvasToBlob(c, mime, quality);
    },
  };
}

/** Decode a Blob into something drawable. */
export async function decodeBlob(blob: Blob): Promise<DrawableSource> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = src;
  });
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const meta = dataUrl.slice(5, comma);
  const mime = meta.split(";")[0] || "application/octet-stream";
  const body = dataUrl.slice(comma + 1);
  if (meta.endsWith(";base64")) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Draw the source at natural size with black rectangles burned in (rects in source pixels). */
export function burnRedactions(source: CanvasImageSource, rects: readonly Rect[]): HTMLCanvasElement {
  const { width, height } = sourceSize(source);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");
  ctx.drawImage(source, 0, 0, width, height);
  ctx.fillStyle = "#000";
  for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
  return c;
}
