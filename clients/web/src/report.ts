import { SDK_NAME, SDK_VERSION } from "./constants.js";

export type Platform = "ios" | "macos" | "web" | "linux" | "windows";

/** The report document, schema 1 (spec/report.schema.json). Optional members are omitted, never null. */
export interface Report {
  schema: 1;
  id: string;
  created_at: string;
  prompt: string;
  sdk: { name: string; version: string };
  app: { id: string; version?: string; build?: string };
  device: {
    platform: Platform;
    os_version?: string;
    model?: string;
    screen?: { width: number; height: number; scale: number };
  };
  locale?: string;
  context?: { screen?: string; title?: string; url?: string };
  screenshot_omitted_reason?: string;
  extra?: Record<string, string>;
}

export interface ReportInput {
  id: string;
  createdAt: Date;
  prompt: string;
  sdk?: { name: string; version: string };
  app: { id: string; version?: string; build?: string };
  device: {
    platform: Platform;
    osVersion?: string;
    model?: string;
    screen?: { width: number; height: number; scale: number };
  };
  locale?: string;
  context?: { screen?: string; title?: string; url?: string };
  screenshotOmittedReason?: string;
  extra?: Record<string, unknown>;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV4(s: string): boolean {
  return UUID_V4.test(s);
}

/** Lowercase UUID v4. crypto.randomUUID needs a secure context, so fall back to getRandomValues. */
export function uuidv4(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID().toLowerCase();
    } catch {
      /* insecure context */
    }
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** UTC with whole seconds: YYYY-MM-DDTHH:MM:SSZ. */
export function formatCreatedAt(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Length in Unicode scalar values (what the Worker counts). */
export function scalarLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function truncateScalars(s: string, max: number): string {
  if (s.length <= max) return s; // UTF-16 length ≥ scalar length
  let out = "";
  let n = 0;
  for (const ch of s) {
    if (n++ >= max) break;
    out += ch;
  }
  return out;
}

function opt(s: string | undefined | null, max: number): string | undefined {
  if (s === undefined || s === null) return undefined;
  const v = String(s);
  return v === "" ? undefined : truncateScalars(v, max);
}

/** Flat string→string map, ≤ 32 keys, keys ≤ 64 chars, values ≤ 1000 chars. Extra keys are dropped. */
export function sanitizeExtra(extra: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!extra) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(extra)) {
    if (n >= 32) break;
    if (v === undefined || v === null || k === "" || scalarLength(k) > 64) continue;
    out[k] = truncateScalars(typeof v === "string" ? v : JSON.stringify(v) ?? String(v), 1000);
    n++;
  }
  return n ? out : undefined;
}

export class PromptError extends RangeError {}

/**
 * Build a schema-1 report document from plain inputs. Pure: the same inputs give the
 * same document. Unknown/empty optional values are omitted, string lengths are clamped
 * to the schema limits, and the prompt is validated (1..maxPromptLength scalars).
 */
export function buildReport(input: ReportInput, maxPromptLength = 4000): Report {
  const prompt = input.prompt.trim();
  const len = scalarLength(prompt);
  if (len < 1) throw new PromptError("prompt is empty");
  if (len > maxPromptLength) throw new PromptError(`prompt is longer than ${maxPromptLength} characters`);
  if (!isUuidV4(input.id)) throw new TypeError(`id is not a lowercase UUID v4: ${input.id}`);

  const app: Report["app"] = { id: opt(input.app.id, 200) ?? "unknown" };
  const appVersion = opt(input.app.version, 64);
  if (appVersion) app.version = appVersion;
  const build = opt(input.app.build, 64);
  if (build) app.build = build;

  const device: Report["device"] = { platform: input.device.platform };
  const os = opt(input.device.osVersion, 200);
  if (os) device.os_version = os;
  const model = opt(input.device.model, 200);
  if (model) device.model = model;
  const sc = input.device.screen;
  if (sc && Number.isFinite(sc.width) && Number.isFinite(sc.height) && sc.scale > 0) {
    device.screen = {
      width: Math.max(0, Math.round(sc.width)),
      height: Math.max(0, Math.round(sc.height)),
      scale: sc.scale,
    };
  }

  const report: Report = {
    schema: 1,
    id: input.id,
    created_at: formatCreatedAt(input.createdAt),
    prompt,
    sdk: input.sdk ?? { name: SDK_NAME, version: SDK_VERSION },
    app,
    device,
  };

  const locale = opt(input.locale, 64);
  if (locale) report.locale = locale;

  if (input.context) {
    const ctx: NonNullable<Report["context"]> = {};
    const screen = opt(input.context.screen, 500);
    if (screen) ctx.screen = screen;
    const title = opt(input.context.title, 500);
    if (title) ctx.title = title;
    const url = opt(input.context.url, 2000);
    if (url) ctx.url = url;
    if (Object.keys(ctx).length) report.context = ctx;
  }

  const reason = opt(input.screenshotOmittedReason, 64);
  if (reason) report.screenshot_omitted_reason = reason;

  const extra = sanitizeExtra(input.extra);
  if (extra) report.extra = extra;
  return report;
}

export function serializeReport(report: Report): string {
  return JSON.stringify(report);
}
