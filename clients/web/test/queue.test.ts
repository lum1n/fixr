// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { Sender } from "../src/sender.js";
import { IdbStore } from "../src/store.js";
import { FakeClock, fakeFetch, makeReport, settle, status } from "./helpers.js";

const T0 = Date.parse("2026-11-05T14:03:12Z");
const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9])], { type: "image/png" });

describe("IndexedDB queue", () => {
  it("persists the report and image before sending, and a later page drains it", async () => {
    const idb = new IDBFactory();
    const report = makeReport(T0);

    // Page 1: the request never completes (tab closed mid-upload).
    const never = fakeFetch(() => new Promise<Response>(() => {}));
    const s1 = new Sender({ endpoint: "https://fixr.test/", projectKey: "pk", store: new IdbStore("fixr", idb), fetch: never.fn, clock: new FakeClock(T0), isOnline: () => true });
    await s1.enqueue(report, { blob: png(), mime: "image/png" });
    await settle();
    expect(never.calls).toHaveLength(1);
    const stored = await new IdbStore("fixr", idb).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: report.id, report, attempts: 0, mime: "image/png" });
    expect([...new Uint8Array(await stored[0]!.image!.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    s1.stop();

    // Page 2: init drains.
    const ok = fakeFetch(() => status(201));
    const store2 = new IdbStore("fixr", idb);
    const s2 = new Sender({ endpoint: "https://fixr.test/", projectKey: "pk", store: store2, fetch: ok.fn, clock: new FakeClock(T0 + 1000), isOnline: () => true });
    await s2.drain();
    expect(ok.calls).toHaveLength(1);
    const { url, init } = ok.calls[0]!;
    expect(url).toBe("https://fixr.test/v1/reports");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer pk", "Idempotency-Key": report.id, "X-Fixr-SDK": "fixr-web/0.1.0" });
    const fd = init.body as FormData;
    expect([...fd.keys()]).toEqual(["report", "screenshot"]);
    expect(JSON.parse(await (fd.get("report") as Blob).text())).toEqual(report);
    expect((fd.get("screenshot") as File).name).toBe("screenshot.png");
    expect(await store2.all()).toEqual([]);
    s2.stop();
  });

  it("keeps attempts and nextAttemptAt across reloads after a retryable failure", async () => {
    const idb = new IDBFactory();
    const report = makeReport(T0);
    const f = fakeFetch(() => status(503));
    const s = new Sender({ endpoint: "https://fixr.test", projectKey: "pk", store: new IdbStore("q", idb), fetch: f.fn, clock: new FakeClock(T0), isOnline: () => true });
    await s.enqueue(report);
    await s.drain();
    s.stop();
    const [rec] = await new IdbStore("q", idb).all();
    expect(rec).toMatchObject({ id: report.id, attempts: 1, nextAttemptAt: T0 + 30_000 });

    // Reloaded before the retry is due: nothing is sent.
    const f2 = fakeFetch(() => status(201));
    const s2 = new Sender({ endpoint: "https://fixr.test", projectKey: "pk", store: new IdbStore("q", idb), fetch: f2.fn, clock: new FakeClock(T0 + 10_000), isOnline: () => true });
    await s2.drain();
    expect(f2.calls).toHaveLength(0);
    await s2.drain(true); // flush ignores backoff
    expect(f2.calls).toHaveLength(1);
    expect(f2.calls[0]!.init.headers).toMatchObject({ "Idempotency-Key": report.id });
    expect(await new IdbStore("q", idb).all()).toEqual([]);
    s2.stop();
  });

  it("drains reports oldest first", async () => {
    const idb = new IDBFactory();
    const store = new IdbStore("order", idb);
    const a = makeReport(T0 - 2000, "a");
    const b = makeReport(T0 - 1000, "b");
    for (const r of [b, a]) await store.put({ id: r.id, report: r, createdAt: Date.parse(r.created_at), attempts: 0, nextAttemptAt: 0 });
    const f = fakeFetch(() => status(201));
    const s = new Sender({ endpoint: "https://fixr.test", projectKey: "pk", store, fetch: f.fn, clock: new FakeClock(T0), isOnline: () => true });
    await s.drain();
    expect(f.calls.map((c) => (c.init.headers as Record<string, string>)["Idempotency-Key"])).toEqual([a.id, b.id]);
  });

  it("on pagehide re-sends in-flight reports as keepalive JSON without the screenshot", async () => {
    const idb = new IDBFactory();
    const report = { ...makeReport(T0) };
    const f = fakeFetch((c) => (c.init.keepalive ? status(201) : new Promise<Response>(() => {})));
    const store = new IdbStore("ka", idb);
    const s = new Sender({ endpoint: "https://fixr.test", projectKey: "pk", store, fetch: f.fn, clock: new FakeClock(T0), isOnline: () => true });
    await s.enqueue(report, { blob: png(), mime: "image/png" });
    await settle();
    expect(s.pending.has(report.id)).toBe(true);
    s.sendKeepalive();
    s.sendKeepalive(); // once per report
    expect(f.calls).toHaveLength(2);
    const ka = f.calls[1]!.init;
    expect(ka.keepalive).toBe(true);
    expect(ka.headers).toMatchObject({ "Idempotency-Key": report.id, "Content-Type": "application/json", Authorization: "Bearer pk" });
    const body = JSON.parse(ka.body as string);
    expect(body).toEqual(report);
    expect(body.screenshot).toBeUndefined();
    expect(body.screenshot_omitted_reason).toBeUndefined();
    expect(new TextEncoder().encode(ka.body as string).length).toBeLessThan(65_536);
    // Still queued: the full report (with image) is retried by the next page.
    expect(await store.all()).toHaveLength(1);
  });
});
