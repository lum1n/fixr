import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PORTS } from "../playwright.config.js";

const OUT = join(process.cwd(), "out");

async function waitForEvent(page: Page, type: string, id?: string) {
  await page.waitForFunction(
    ([t, i]) => ((window as any).fixrEvents || []).some((e: any) => e.type === t && (!i || e.id === i)),
    [type, id] as const,
  );
  return page.evaluate(([t, i]) => (window as any).fixrEvents.find((e: any) => e.type === t && (!i || e.id === i)), [type, id] as const);
}

test("hotkey → dialog → redact → send lands in the echo server with a screenshot", async ({ page }) => {
  await page.goto(`/demo/index.html?endpoint=http://localhost:${PORTS.echo}`);
  await page.keyboard.press("Control+Shift+F");
  const dialog = page.locator("fixr-report [role=dialog]");
  await expect(dialog).toBeVisible();
  const canvas = page.locator("fixr-report canvas");
  await expect(canvas).toBeVisible();

  // Black out the middle of the screenshot.
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 5 });
  await page.mouse.up();

  await page.locator("fixr-report textarea").fill("Make Save the same height as Cancel");
  await page.locator("fixr-report [data-send]").click();
  await expect(page.locator("fixr-report")).toHaveCount(0);

  const delivered = await waitForEvent(page, "delivered");
  expect(delivered.status).toBe(201);
  const id: string = delivered.id;
  const report = JSON.parse(readFileSync(join(OUT, "e2e", `${id}.json`), "utf8"));
  expect(report).toMatchObject({
    schema: 1,
    id,
    prompt: "Make Save the same height as Cancel",
    sdk: { name: "fixr-web", version: "0.1.0" },
    app: { id: `localhost:${PORTS.demo}`, version: "0.0.0-demo" },
    device: { platform: "web" },
    context: { title: "fixr web demo" },
    extra: { demo: "true" },
  });
  expect(report.screenshot_omitted_reason).toBeUndefined();

  const img = readdirSync(join(OUT, "e2e")).find((f) => f.startsWith(id) && !f.endsWith(".json"))!;
  expect(img).toMatch(/\.(png|jpg)$/);
  const bytes = readFileSync(join(OUT, "e2e", img));
  // The redaction is burned in: the centre pixel is black.
  const px = await page.evaluate(async ({ b64, mime }) => {
    const blob = await (await fetch(`data:${mime};base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    return { size: [bmp.width, bmp.height], rgb: [...ctx.getImageData(bmp.width >> 1, bmp.height >> 1, 1, 1).data].slice(0, 3) };
  }, { b64: bytes.toString("base64"), mime: img.endsWith(".png") ? "image/png" : "image/jpeg" });
  expect(Math.max(...px.size)).toBeLessThanOrEqual(2000);
  expect(px.rgb).toEqual([0, 0, 0]);
});

test("Esc closes the dialog without sending", async ({ page }) => {
  await page.goto(`/demo/index.html?endpoint=http://localhost:${PORTS.echo}&capture=none`);
  await page.keyboard.press("Control+Shift+F");
  await expect(page.locator("fixr-report [role=dialog]")).toBeVisible();
  await expect(page.locator("fixr-report canvas")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("fixr-report")).toHaveCount(0);
});

test("a 503 is retried with the same Idempotency-Key and then delivered", async ({ page }) => {
  await page.goto(`/demo/index.html?endpoint=http://localhost:${PORTS.retry}&capture=none`);
  const id = await page.evaluate(() => (window as any).fixr.send("retry me"));
  const retry = await waitForEvent(page, "retry", id);
  expect(retry).toMatchObject({ attempts: 1, status: 503 });
  await page.evaluate(() => (window as any).fixr.flush());
  const delivered = await waitForEvent(page, "delivered", id);
  expect(delivered.status).toBe(201);
  const report = JSON.parse(readFileSync(join(OUT, "e2e-retry", `${id}.json`), "utf8"));
  expect(report.screenshot_omitted_reason).toBe("capture_disabled");
});

test("a report queued while the server is down is delivered by the next page load", async ({ page }) => {
  await page.goto(`/demo/index.html?endpoint=http://localhost:${PORTS.down}&capture=none`);
  const id = await page.evaluate(() => (window as any).fixr.send("survive a reload"));
  const retry = await waitForEvent(page, "retry", id);
  expect(retry.attempts).toBe(1);
  // The retry is 30 s out; pretend that time has passed by making the stored record due.
  await page.evaluate(
    (rid) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("fixr");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("reports", "readwrite");
          const store = tx.objectStore("reports");
          const get = store.get(rid);
          get.onsuccess = () => store.put({ ...get.result, nextAttemptAt: 0 });
          tx.oncomplete = () => (open.result.close(), resolve());
        };
      }),
    id,
  );
  await page.goto(`/demo/index.html?endpoint=http://localhost:${PORTS.echo}&capture=none`);
  const delivered = await waitForEvent(page, "delivered", id);
  expect(delivered.status).toBe(201);
  expect(existsSync(join(OUT, "e2e", `${id}.json`))).toBe(true);
});
