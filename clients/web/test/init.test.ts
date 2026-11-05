import { afterEach, describe, expect, it } from "vitest";
import { init, type Fixr } from "../src/index.js";
import { MemoryStore } from "../src/store.js";
import { fakeFetch, settle, status } from "./helpers.js";

let fixr: Fixr | undefined;
afterEach(() => {
  fixr?.destroy();
  fixr = undefined;
});

async function reportOf(call: { init: RequestInit }) {
  const fd = call.init.body as FormData;
  const part = fd.get("report") as Blob;
  expect(part.type).toBe("application/json");
  const text = await new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsText(part);
  });
  return JSON.parse(text);
}

describe("init", () => {
  it("send() queues and posts a web report with capture_disabled", async () => {
    const f = fakeFetch(() => status(201));
    fixr = init({ endpoint: "https://fixr.test", projectKey: "pk", capture: "none", store: new MemoryStore(), fetch: f.fn, metadata: { branch: "main" }, appVersion: "2.0.0" });
    const id = await fixr.send("Make the title bold");
    await fixr.flush();
    expect(f.calls).toHaveLength(1);
    const r = await reportOf(f.calls[0]!);
    expect(r).toMatchObject({
      schema: 1,
      id,
      prompt: "Make the title bold",
      sdk: { name: "fixr-web", version: "0.1.0" },
      app: { id: location.host, version: "2.0.0" },
      device: { platform: "web" },
      context: { url: location.href },
      screenshot_omitted_reason: "capture_disabled",
      extra: { branch: "main" },
    });
    expect(r.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect((f.calls[0]!.init.body as FormData).has("screenshot")).toBe(false);
  });

  it("sends capture_failed when the capture function throws", async () => {
    const f = fakeFetch(() => status(201));
    fixr = init({ endpoint: "https://fixr.test", projectKey: "pk", capture: () => { throw new Error("nope"); }, store: new MemoryStore(), fetch: f.fn });
    await fixr.send("x");
    await fixr.flush();
    expect((await reportOf(f.calls[0]!)).screenshot_omitted_reason).toBe("capture_failed");
  });

  it("rejects an empty prompt", async () => {
    fixr = init({ endpoint: "https://fixr.test", projectKey: "pk", capture: "none", store: new MemoryStore(), fetch: fakeFetch(() => status(201)).fn });
    await expect(fixr.send("  ")).rejects.toThrow(RangeError);
  });

  it("the hotkey opens a shadow-DOM dialog; Esc closes it", async () => {
    const f = fakeFetch(() => status(201));
    fixr = init({ endpoint: "https://fixr.test", projectKey: "pk", capture: "none", hotkey: "ctrl+shift+f", store: new MemoryStore(), fetch: f.fn });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true }));
    await settle();
    const host = document.querySelector("fixr-report")!;
    expect(host).not.toBeNull();
    expect(host.hasAttribute("data-fixr-ignore")).toBe(true);
    const root = host.shadowRoot!;
    expect(root.querySelector("[role=dialog]")).not.toBeNull();
    expect((root.querySelector("[data-preview]") as HTMLElement).hidden).toBe(true);
    root.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }));
    await settle();
    expect(document.querySelector("fixr-report")).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("the dialog's Send queues the typed prompt", async () => {
    const f = fakeFetch(() => status(201));
    fixr = init({ endpoint: "https://fixr.test", projectKey: "pk", capture: "none", store: new MemoryStore(), fetch: f.fn });
    const opened = fixr.open();
    await settle();
    const root = document.querySelector("fixr-report")!.shadowRoot!;
    const ta = root.querySelector("textarea")!;
    const send = root.querySelector("[data-send]") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    ta.value = "Align the buttons";
    ta.dispatchEvent(new Event("input"));
    expect(send.disabled).toBe(false);
    send.click();
    const id = await opened;
    await fixr.flush();
    const r = await reportOf(f.calls[0]!);
    expect(r).toMatchObject({ id, prompt: "Align the buttons", screenshot_omitted_reason: "capture_disabled" });
  });

  it("traps Tab focus inside the dialog", async () => {
    fixr = init({ endpoint: "https://fixr.test", projectKey: "pk", capture: "none", store: new MemoryStore(), fetch: fakeFetch(() => status(201)).fn });
    void fixr.open();
    await settle();
    const root = document.querySelector("fixr-report")!.shadowRoot!;
    const cancel = root.querySelector("[data-cancel]") as HTMLButtonElement;
    cancel.focus();
    // Send is disabled, so Cancel is last; Tab wraps to the textarea.
    cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true }));
    expect(root.activeElement).toBe(root.querySelector("textarea"));
    root.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, composed: true }));
    expect(root.activeElement).toBe(cancel);
  });
});
