export const SDK_NAME = "fixr-web";
export const SDK_VERSION = "0.1.0";
/** Browsers forbid setting User-Agent, so the SDK identifies itself with this header. */
export const SDK_HEADER = "X-Fixr-SDK";
export const SDK_HEADER_VALUE = `${SDK_NAME}/${SDK_VERSION}`;

/** Limits from spec/wire-format.md. Identical on every client; enforced by the Worker. */
export interface Limits {
  /** Max prompt length in Unicode scalar values. */
  maxPromptLength: number;
  /** Image long edge, px. */
  maxLongEdge: number;
  /** Image bytes. */
  maxImageBytes: number;
  /** Below this long edge the image ladder gives up (`too_large`). */
  minLongEdge: number;
  /** Request body bytes. */
  maxBodyBytes: number;
  /** JPEG qualities tried after PNG, in order. */
  jpegQualities: readonly number[];
  /** Downscale factor applied when no encoding fits. */
  scaleStep: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxPromptLength: 4000,
  maxLongEdge: 2000,
  maxImageBytes: 2_000_000,
  minLongEdge: 200,
  maxBodyBytes: 2_621_440,
  jpegQualities: [0.9, 0.8, 0.7, 0.6, 0.5],
  scaleStep: 0.75,
};

/** keepalive fetch bodies are capped at 64 KiB by browsers. */
export const KEEPALIVE_MAX_BYTES = 65_536;
