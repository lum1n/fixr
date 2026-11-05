import { DEFAULT_LIMITS, SDK_NAME, SDK_VERSION, type Limits } from "./constants.js";
import { runCapture, type CaptureOption, type CaptureResult } from "./capture.js";
import { collectPageMetadata } from "./metadata.js";
import { buildReport, uuidv4, type Report } from "./report.js";
import { burnRedactions, canvasEncoder, decodeBlob, prepareImage, type DrawableSource, type Rect } from "./image.js";
import { Sender, type Clock, type SenderEvent } from "./sender.js";
import { defaultStore, type QueueStore } from "./store.js";
import { createDialog, type FixrDialog } from "./ui.js";
import { matchesHotkey, parseHotkey } from "./hotkey.js";
import type { Screenshot } from "./wire.js";

export type Metadata = Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>);

export interface FixrOptions {
  /** Worker base URL (`https://fixr.example.workers.dev`) or the full `/v1/reports` URL. */
  endpoint: string;
  projectKey: string;
  /** Opens the dialog. Default "mod+shift+f" (⌘⇧F / Ctrl+Shift+F). `false` disables it. */
  hotkey?: string | false;
  /** Default "dom" (html-to-image). "display" = getDisplayMedia, "none" = no screenshot, or your own function. */
  capture?: CaptureOption;
  /** Flat string map sent as `extra` (values are stringified). A function is called per report. */
  metadata?: Metadata;
  limits?: Partial<Limits>;
  /** Default: location.host. */
  appId?: string;
  appVersion?: string;
  appBuild?: string;
  /** Optional `context.screen` (route or view name), per report. */
  screen?: () => string | undefined;
  /** Send the `X-Fixr-SDK` header (default true). The server's CORS allow-list must include it. */
  sdkHeader?: boolean;
  onEvent?: (e: SenderEvent) => void;
  /** IndexedDB database name. Default "fixr". */
  dbName?: string;
  /** Testing seams. */
  store?: QueueStore;
  fetch?: typeof fetch;
  clock?: Clock;
}

export interface SendOptions {
  /** Image to attach. `undefined` = capture per `capture`; `null` = none. */
  screenshot?: CaptureResult;
  /** Reason sent when there is no screenshot. Default: from capture, or "user_removed" for `null`. */
  screenshotOmittedReason?: string;
  /** Black rectangles (image pixels) burned in before encoding. */
  redactions?: Rect[];
  extra?: Record<string, unknown>;
}

export interface Fixr {
  /** Capture, then show the dialog. Resolves with the report id once queued, or null if cancelled. */
  open(): Promise<string | null>;
  /** Queue a report without UI. Resolves with its id once it is persisted. */
  send(prompt: string, options?: SendOptions): Promise<string>;
  /** Attempt every queued report now, ignoring backoff. */
  flush(): Promise<void>;
  destroy(): void;
}

async function toDrawable(img: CaptureResult & object): Promise<DrawableSource> {
  if (typeof Blob !== "undefined" && img instanceof Blob) return decodeBlob(img);
  return img as DrawableSource;
}

export function init(options: FixrOptions): Fixr {
  if (!options?.endpoint) throw new TypeError("fixr: endpoint is required");
  if (!options.projectKey) throw new TypeError("fixr: projectKey is required");
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const capture: CaptureOption = options.capture ?? "dom";
  const sender = new Sender({
    endpoint: options.endpoint,
    projectKey: options.projectKey,
    store: options.store ?? defaultStore(options.dbName),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.sdkHeader !== undefined ? { sdkHeader: options.sdkHeader } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  const clock = options.clock;
  const now = () => new Date(clock ? clock.now() : Date.now());

  let dialog: FixrDialog | null = null;
  let opening = false;
  let destroyed = false;

  async function prepare(source: DrawableSource | undefined, rects: Rect[]): Promise<{ shot?: Screenshot; reason?: string }> {
    if (!source) return {};
    const burned = rects.length ? burnRedactions(source, rects) : source;
    const res = await prepareImage(canvasEncoder(burned), limits);
    if ("omitted" in res) return { reason: res.omitted };
    return { shot: { blob: res.blob, mime: res.mime } };
  }

  async function enqueue(prompt: string, source: DrawableSource | undefined, rects: Rect[], reason: string | undefined, extra?: Record<string, unknown>): Promise<string> {
    const id = uuidv4();
    const createdAt = now();
    const [page, meta] = await Promise.all([
      collectPageMetadata({ appId: options.appId, appVersion: options.appVersion, appBuild: options.appBuild }),
      typeof options.metadata === "function" ? Promise.resolve(options.metadata()).catch(() => ({})) : options.metadata,
    ]);
    const screen = options.screen?.();
    if (screen) page.context = { ...page.context, screen };
    let shot: Screenshot | undefined;
    try {
      const p = await prepare(source, rects);
      shot = p.shot;
      if (p.reason) reason = p.reason;
    } catch (e) {
      console.warn("[fixr] image encoding failed:", e);
      reason = "capture_failed";
    }
    const mergedExtra = meta || extra ? { ...(meta ?? {}), ...(extra ?? {}) } : undefined;
    const report: Report = buildReport(
      {
        id,
        createdAt,
        prompt,
        sdk: { name: SDK_NAME, version: SDK_VERSION },
        ...page,
        ...(shot ? {} : reason ? { screenshotOmittedReason: reason } : {}),
        ...(mergedExtra ? { extra: mergedExtra } : {}),
      },
      limits.maxPromptLength,
    );
    await sender.enqueue(report, shot);
    return id;
  }

  async function open(): Promise<string | null> {
    if (destroyed || opening || dialog?.isConnected) return null;
    opening = true;
    try {
      // Capture first, while the page is untouched (and inside the user gesture for getDisplayMedia).
      const cap = await runCapture(capture, null);
      let source: DrawableSource | undefined;
      let reason: string | undefined;
      if ("image" in cap) {
        try {
          source = await toDrawable(cap.image);
        } catch {
          reason = "capture_failed";
        }
      } else reason = cap.omitted;
      dialog = dialog ?? createDialog();
      if (!dialog || destroyed) return null;
      document.body.appendChild(dialog);
      const result = await dialog.open({ ...(source ? { image: source } : {}), maxPromptLength: limits.maxPromptLength });
      if (!result) return null;
      if (result.removed && source) reason = "user_removed";
      return await enqueue(result.prompt, result.removed ? undefined : source, result.rects, reason);
    } finally {
      opening = false;
    }
  }

  async function send(prompt: string, o: SendOptions = {}): Promise<string> {
    let source: DrawableSource | undefined;
    let reason = o.screenshotOmittedReason;
    if (o.screenshot === undefined) {
      const cap = await runCapture(capture, dialog);
      if ("image" in cap) source = await toDrawable(cap.image).catch(() => ((reason ??= "capture_failed"), undefined));
      else reason ??= cap.omitted;
    } else if (o.screenshot === null) {
      reason ??= "user_removed";
    } else {
      source = await toDrawable(o.screenshot).catch(() => ((reason ??= "capture_failed"), undefined));
    }
    return enqueue(prompt, source, o.redactions ?? [], reason, o.extra);
  }

  const hk = options.hotkey === false ? null : parseHotkey(options.hotkey ?? "mod+shift+f");
  const onKeydown = (e: KeyboardEvent) => {
    if (hk && !e.repeat && matchesHotkey(e, hk)) {
      e.preventDefault();
      void open();
    }
  };
  const onOnline = () => void sender.drain();
  const onPageHide = () => sender.sendKeepalive();
  const onVisible = () => {
    if (document.visibilityState === "visible") void sender.drain();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onKeydown, true);
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisible);
  }
  void sender.drain();

  return {
    open,
    send,
    flush: () => sender.drain(true),
    destroy() {
      destroyed = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("keydown", onKeydown, true);
        window.removeEventListener("online", onOnline);
        window.removeEventListener("pagehide", onPageHide);
        document.removeEventListener("visibilitychange", onVisible);
      }
      dialog?.close();
      dialog?.remove();
      dialog = null;
      sender.stop();
    },
  };
}

export { DEFAULT_LIMITS, SDK_NAME, SDK_VERSION } from "./constants.js";
export type { Limits } from "./constants.js";
export type { CaptureFn, CaptureOption, CaptureResult } from "./capture.js";
export type { Report, ReportInput } from "./report.js";
export type { SenderEvent, Clock } from "./sender.js";
export type { QueueStore, QueuedReport } from "./store.js";
export type { Rect } from "./image.js";
export { buildReport, formatCreatedAt } from "./report.js";
export { prepareImage, type ImageEncoder } from "./image.js";
export { buildMultipart, buildJsonBody, classifyStatus } from "./wire.js";
export { retryDelay, shouldGiveUp } from "./backoff.js";
