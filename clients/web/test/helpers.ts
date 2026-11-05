import type { Clock } from "../src/sender.js";
import { buildReport, uuidv4, type Report } from "../src/report.js";

export class FakeClock implements Clock {
  timers: { id: number; at: number; fn: () => void }[] = [];
  private seq = 0;
  constructor(public t: number) {}
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown) {
    this.timers = this.timers.filter((x) => x.id !== h);
  }
  /** Earliest armed timer, relative to now. */
  nextTimerIn(): number | undefined {
    if (!this.timers.length) return undefined;
    return Math.min(...this.timers.map((x) => x.at)) - this.t;
  }
}

/** Let promise chains (and fake-indexeddb's macrotasks) run. */
export const settle = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

export function makeReport(createdAtMs: number, prompt = "fix it"): Report {
  return buildReport({
    id: uuidv4(),
    createdAt: new Date(createdAtMs),
    prompt,
    app: { id: "example.com" },
    device: { platform: "web" },
  });
}

export type FetchCall = { url: string; init: RequestInit };

export function fakeFetch(respond: (call: FetchCall, n: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call, calls.length);
  }) as typeof fetch;
  return { fn, calls };
}

export const status = (s: number, headers: Record<string, string> = {}) =>
  new Response(s === 204 ? null : JSON.stringify({}), { status: s, headers });
