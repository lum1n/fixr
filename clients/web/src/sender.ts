import { KEEPALIVE_MAX_BYTES } from "./constants.js";
import { retryDelay, shouldGiveUp } from "./backoff.js";
import type { Report } from "./report.js";
import { MemoryStore, type QueuedReport, type QueueStore } from "./store.js";
import { buildJsonBody, buildMultipart, classifyResponse, requestHeaders, type Outcome, type Screenshot } from "./wire.js";

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type SenderEvent =
  | { type: "queued"; id: string }
  | { type: "delivered"; id: string; duplicate: boolean; status: number }
  | { type: "retry"; id: string; attempts: number; nextAttemptAt: number; status?: number }
  | { type: "dropped"; id: string; reason: "permanent" | "expired"; status?: number };

export interface SenderOptions {
  endpoint: string;
  projectKey: string;
  store: QueueStore;
  fetch?: typeof fetch;
  clock?: Clock;
  /** Send X-Fixr-SDK (default true). Needs the header in the server's CORS allow-list. */
  sdkHeader?: boolean;
  /** `false` while offline; drains are skipped then. Default: navigator.onLine. */
  isOnline?: () => boolean;
  onEvent?: (e: SenderEvent) => void;
  /** Longest sleep between queue checks (ms). Default 5 min. */
  maxSleepMs?: number;
}

/** `https://x.workers.dev` → `https://x.workers.dev/v1/reports`; a URL already ending in /v1/reports is kept. */
export function reportsUrl(endpoint: string): string {
  const e = endpoint.replace(/\/+$/, "");
  return /\/v1\/reports$/.test(e) ? e : `${e}/v1/reports`;
}

/**
 * Persistent fire-and-forget queue. Every report is written to the store before its first
 * request, deleted on 2xx or a permanent failure, and rescheduled with backoff otherwise.
 */
export class Sender {
  private store: QueueStore;
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly clock: Clock;
  private readonly inFlight = new Map<string, QueuedReport>();
  private readonly keptAlive = new Set<string>();
  private draining: Promise<void> | null = null;
  private again = false;
  private againForce = false;
  private timer: unknown = null;
  private stopped = false;

  constructor(private readonly opts: SenderOptions) {
    this.store = opts.store;
    this.url = reportsUrl(opts.endpoint);
    this.fetchFn = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.clock = opts.clock ?? realClock;
  }

  get pending(): ReadonlySet<string> {
    return new Set(this.inFlight.keys());
  }

  /** Persist, then kick a drain (not awaited: the caller's job ends once the report is stored). */
  async enqueue(report: Report, screenshot?: Screenshot): Promise<void> {
    const rec: QueuedReport = {
      id: report.id,
      report,
      createdAt: Date.parse(report.created_at),
      attempts: 0,
      nextAttemptAt: 0,
    };
    if (screenshot) {
      rec.image = screenshot.blob;
      rec.mime = screenshot.mime;
    }
    try {
      await this.store.put(rec);
    } catch {
      // IndexedDB refused (private mode, quota): keep going in memory for this page.
      const mem = new MemoryStore();
      for (const r of await this.store.all().catch(() => [])) await mem.put(r);
      this.store.close();
      this.store = mem;
      await mem.put(rec);
    }
    this.opts.onEvent?.({ type: "queued", id: rec.id });
    void this.drain();
  }

  /** Attempt every due report. `force` ignores nextAttemptAt (attempts and backoff still count). */
  drain(force = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.draining) {
      this.again = true;
      this.againForce ||= force;
      return this.draining;
    }
    this.draining = (async () => {
      let f = force;
      do {
        this.again = false;
        await this.drainOnce(f);
        f = this.againForce;
        this.againForce = false;
      } while (this.again && !this.stopped);
    })()
      .catch(() => {})
      .finally(() => {
        this.draining = null;
        void this.schedule();
      });
    return this.draining;
  }

  private online(): boolean {
    if (this.opts.isOnline) return this.opts.isOnline();
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  private async drainOnce(force: boolean) {
    const recs = (await this.store.all()).sort((a, b) => a.createdAt - b.createdAt);
    for (const rec of recs) {
      if (this.stopped) return;
      if (this.inFlight.has(rec.id)) continue;
      const now = this.clock.now();
      if (shouldGiveUp(rec.attempts, rec.createdAt, now)) {
        await this.store.delete(rec.id);
        this.opts.onEvent?.({ type: "dropped", id: rec.id, reason: "expired" });
        continue;
      }
      if (!force && rec.nextAttemptAt > now) continue;
      if (!this.online()) return;
      await this.attempt(rec);
    }
  }

  private async attempt(rec: QueuedReport) {
    this.inFlight.set(rec.id, rec);
    let outcome: Outcome;
    let status: number | undefined;
    try {
      const screenshot: Screenshot | undefined = rec.image && rec.mime ? { blob: rec.image, mime: rec.mime } : undefined;
      const headers = requestHeaders(this.opts.projectKey, rec.id, this.opts.sdkHeader ?? true);
      let body: BodyInit;
      if (typeof FormData !== "undefined") body = buildMultipart(rec.report, screenshot);
      else {
        headers["Content-Type"] = "application/json";
        body = await buildJsonBody(rec.report, screenshot);
      }
      const res = await this.fetchFn(this.url, { method: "POST", headers, body });
      status = res.status;
      outcome = classifyResponse(res, this.clock.now());
    } catch {
      outcome = { kind: "retry" };
    } finally {
      this.inFlight.delete(rec.id);
    }

    if (outcome.kind === "delivered") {
      await this.store.delete(rec.id);
      this.keptAlive.delete(rec.id);
      this.opts.onEvent?.({ type: "delivered", id: rec.id, duplicate: outcome.duplicate, status: status! });
      return;
    }
    if (outcome.kind === "permanent") {
      await this.store.delete(rec.id);
      this.opts.onEvent?.({ type: "dropped", id: rec.id, reason: "permanent", status: outcome.status });
      return;
    }
    const now = this.clock.now();
    const attempts = rec.attempts + 1;
    if (shouldGiveUp(attempts, rec.createdAt, now)) {
      await this.store.delete(rec.id);
      this.opts.onEvent?.({ type: "dropped", id: rec.id, reason: "expired", ...(status ? { status } : {}) });
      return;
    }
    const nextAttemptAt = now + retryDelay(attempts, outcome.retryAfterMs);
    await this.store.put({ ...rec, attempts, nextAttemptAt });
    this.opts.onEvent?.({ type: "retry", id: rec.id, attempts, nextAttemptAt, ...(status ? { status } : {}) });
  }

  /** Arm one timer for the earliest due report (capped at maxSleepMs). */
  private async schedule() {
    if (this.stopped) return;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    let recs: QueuedReport[];
    try {
      recs = await this.store.all();
    } catch {
      return;
    }
    if (!recs.length || this.stopped || this.draining) return;
    const next = Math.min(...recs.map((r) => r.nextAttemptAt));
    const maxSleep = this.opts.maxSleepMs ?? 300_000;
    const wait = this.online() ? Math.min(Math.max(0, next - this.clock.now()), maxSleep) : maxSleep;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, Math.max(wait, 1000));
  }

  /**
   * pagehide: the in-flight multipart upload is about to be killed. Re-send each in-flight
   * report as a keepalive JSON request without the screenshot (keepalive bodies are capped
   * at 64 KiB), same Idempotency-Key. The stored copy stays queued; the next page load
   * gets a 200 duplicate for it if the keepalive made it.
   */
  sendKeepalive() {
    for (const rec of this.inFlight.values()) {
      if (this.keptAlive.has(rec.id)) continue;
      const body = JSON.stringify(rec.report);
      if (new Blob([body]).size > KEEPALIVE_MAX_BYTES - 1024) continue;
      this.keptAlive.add(rec.id);
      const headers = { ...requestHeaders(this.opts.projectKey, rec.id, this.opts.sdkHeader ?? true), "Content-Type": "application/json" };
      try {
        this.fetchFn(this.url, { method: "POST", headers, body, keepalive: true }).catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.store.close();
  }
}
