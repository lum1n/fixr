import { describe, expect, it } from "vitest";
import { DAILY_MS, MAX_AGE_MS, retryDelay, shouldGiveUp } from "../src/backoff.js";
import { Sender, type SenderEvent } from "../src/sender.js";
import { MemoryStore } from "../src/store.js";
import { FakeClock, fakeFetch, makeReport, settle, status } from "./helpers.js";

const T0 = Date.parse("2026-11-05T14:03:12Z");
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

function setup(respond: Parameters<typeof fakeFetch>[0]) {
  const clock = new FakeClock(T0);
  const store = new MemoryStore();
  const { fn, calls } = fakeFetch(respond);
  const events: SenderEvent[] = [];
  const sender = new Sender({ endpoint: "https://fixr.test", projectKey: "pk", store, fetch: fn, clock, isOnline: () => true, onEvent: (e) => events.push(e) });
  return { clock, store, calls, events, sender };
}

describe("retry schedule", () => {
  it("is 30 s, 2 min, 10 min, 1 h, 6 h, then every 24 h", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 19].map((n) => retryDelay(n))).toEqual([30 * S, 2 * MIN, 10 * MIN, H, 6 * H, DAILY_MS, DAILY_MS, DAILY_MS]);
  });

  it("lets a longer Retry-After win, never a shorter one", () => {
    expect(retryDelay(1, 90 * S)).toBe(90 * S);
    expect(retryDelay(4, 90 * S)).toBe(H);
  });

  it("gives up after 20 attempts or 7 days", () => {
    expect(shouldGiveUp(19, T0, T0)).toBe(false);
    expect(shouldGiveUp(20, T0, T0)).toBe(true);
    expect(shouldGiveUp(0, T0, T0 + MAX_AGE_MS - 1)).toBe(false);
    expect(shouldGiveUp(0, T0, T0 + MAX_AGE_MS)).toBe(true);
  });
});

describe("sender backoff with a fake clock", () => {
  it("follows the schedule and drops the report 7 days after created_at", async () => {
    const { clock, store, calls, events, sender } = setup(() => status(503));
    await sender.enqueue(makeReport(T0));
    await sender.drain();
    const expected = [30 * S, 2 * MIN, 10 * MIN, H, 6 * H, DAILY_MS, DAILY_MS];
    for (const [i, d] of expected.entries()) {
      const [rec] = await store.all();
      expect(rec!.attempts).toBe(i + 1);
      expect(rec!.nextAttemptAt - clock.now()).toBe(d);
      // Not due a millisecond early.
      clock.t = rec!.nextAttemptAt - 1;
      await sender.drain();
      expect(calls).toHaveLength(i + 1);
      clock.t = rec!.nextAttemptAt;
      await sender.drain();
      expect(calls).toHaveLength(i + 2);
    }
    // Keep going daily until the 7-day limit.
    while ((await store.all()).length) {
      clock.t = (await store.all())[0]!.nextAttemptAt;
      await sender.drain();
    }
    expect(clock.t - T0).toBeGreaterThanOrEqual(MAX_AGE_MS);
    expect(calls.length).toBeLessThan(20);
    expect(events.at(-1)).toMatchObject({ type: "dropped", reason: "expired" });
  });

  it("drops after the 20th failed attempt", async () => {
    const { store, calls, events, sender } = setup(() => status(500));
    await sender.enqueue(makeReport(T0));
    for (let i = 0; i < 25; i++) await sender.drain(true);
    expect(calls).toHaveLength(20);
    expect(await store.all()).toEqual([]);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(19);
    expect(events.at(-1)).toMatchObject({ type: "dropped", reason: "expired", status: 500 });
  });

  it("uses Retry-After on 429 when it is longer", async () => {
    const { clock, store, sender } = setup(() => status(429, { "Retry-After": "300" }));
    await sender.enqueue(makeReport(T0));
    await sender.drain();
    expect((await store.all())[0]!.nextAttemptAt - clock.now()).toBe(300 * S);
  });

  it("retries network errors and 408", async () => {
    const { store, sender } = setup((_, n) => (n === 1 ? Promise.reject(new TypeError("Failed to fetch")) : status(408)));
    await sender.enqueue(makeReport(T0));
    await sender.drain(); // joins the drain enqueue started: network error
    await sender.drain(true); // 408
    expect((await store.all())[0]!.attempts).toBe(2);
  });

  it("deletes on 201/200 and on permanent 4xx", async () => {
    for (const [code, type] of [[201, "delivered"], [200, "delivered"], [401, "dropped"], [422, "dropped"], [404, "dropped"]] as const) {
      const { store, calls, events, sender } = setup(() => status(code));
      await sender.enqueue(makeReport(T0));
      await sender.drain();
      expect(calls).toHaveLength(1);
      expect(await store.all()).toEqual([]);
      expect(events.at(-1)!.type).toBe(type);
    }
  });

  it("arms a timer for the next due report", async () => {
    const { clock, sender } = setup(() => status(503));
    await sender.enqueue(makeReport(T0));
    await sender.drain();
    await settle();
    expect(clock.nextTimerIn()).toBe(30 * S);
    sender.stop();
    expect(clock.timers).toEqual([]);
  });

  it("does not attempt while offline", async () => {
    const clock = new FakeClock(T0);
    const { fn, calls } = fakeFetch(() => status(201));
    let online = false;
    const sender = new Sender({ endpoint: "https://fixr.test", projectKey: "pk", store: new MemoryStore(), fetch: fn, clock, isOnline: () => online });
    await sender.enqueue(makeReport(T0));
    await sender.drain();
    expect(calls).toHaveLength(0);
    online = true;
    await sender.drain();
    expect(calls).toHaveLength(1);
  });
});
