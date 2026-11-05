import { dataUrlToBlob } from "./image.js";

/** What a capture returns: something drawable or encoded image bytes. `null` = no screenshot. */
export type CaptureResult = Blob | HTMLCanvasElement | HTMLImageElement | ImageBitmap | null;
export type CaptureFn = (ctx: { host: Element | null }) => Promise<CaptureResult> | CaptureResult;
export type CaptureOption = "dom" | "display" | "none" | CaptureFn;

interface HtmlToImage {
  toPng(node: HTMLElement, options?: Record<string, unknown>): Promise<string>;
}

/** html-to-image: the UMD global (window.htmlToImage) if a script tag loaded it, else a dynamic import. */
export async function loadHtmlToImage(): Promise<HtmlToImage> {
  const g = (globalThis as { htmlToImage?: HtmlToImage }).htmlToImage;
  if (g?.toPng) return g;
  try {
    const mod = (await import("html-to-image")) as unknown as HtmlToImage & { default?: HtmlToImage };
    return typeof mod.toPng === "function" ? mod : mod.default!;
  } catch (e) {
    throw new Error(`capture "dom" needs the optional peer dependency html-to-image: ${String(e)}`);
  }
}

/** Filter for html-to-image: drop the fixr host element and anything under [data-fixr-ignore]. */
export function domFilter(host: Element | null): (node: Node) => boolean {
  return (node: Node) => {
    if (host && node === host) return false;
    if (node.nodeType === 1) {
      const el = node as Element;
      if (el.hasAttribute?.("data-fixr-ignore")) return false;
      if (el.localName === "fixr-report") return false;
    }
    return true;
  };
}

const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;

/** The colour the browser paints behind the page; html-to-image would leave it transparent. */
export function pageBackground(): string {
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && !TRANSPARENT.test(bg)) return bg;
  }
  const scheme = getComputedStyle(document.documentElement).colorScheme || "";
  const prefersDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = /dark/.test(scheme) && (!/light/.test(scheme) || prefersDark);
  return dark ? "#121212" : "#ffffff";
}

export async function captureDom(host: Element | null): Promise<Blob> {
  const lib = await loadHtmlToImage();
  const root = document.documentElement;
  const dataUrl = await lib.toPng(root, {
    filter: domFilter(host),
    backgroundColor: pageBackground(),
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    width: window.innerWidth,
    height: window.innerHeight,
    canvasWidth: window.innerWidth,
    canvasHeight: window.innerHeight,
    // Render what is on screen: shift the document by the current scroll offset.
    style: { transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`, transformOrigin: "0 0" },
    cacheBust: false,
    skipFonts: false,
  });
  return dataUrlToBlob(dataUrl);
}

/** getDisplayMedia (preferCurrentTab): one frame, then every track is stopped. */
export async function captureDisplay(): Promise<HTMLCanvasElement> {
  const md = navigator.mediaDevices as MediaDevices | undefined;
  if (!md?.getDisplayMedia) throw new Error("getDisplayMedia unavailable");
  const stream = await md.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await new Promise<void>((resolve) => {
      const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => void };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => resolve());
      else if (video.readyState >= 2) resolve();
      else video.addEventListener("loadeddata", () => resolve(), { once: true });
    });
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("2d canvas unavailable");
    ctx.drawImage(video, 0, 0);
    video.srcObject = null;
    return c;
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

export type CaptureOutcome = { image: CaptureResult & object } | { omitted: "capture_disabled" | "capture_failed" };

export async function runCapture(option: CaptureOption, host: Element | null): Promise<CaptureOutcome> {
  if (option === "none") return { omitted: "capture_disabled" };
  try {
    let image: CaptureResult;
    if (option === "dom") image = await captureDom(host);
    else if (option === "display") image = await captureDisplay();
    else image = await option({ host });
    return image ? { image } : { omitted: "capture_disabled" };
  } catch (e) {
    if (typeof console !== "undefined") console.warn("[fixr] capture failed:", e);
    return { omitted: "capture_failed" };
  }
}
