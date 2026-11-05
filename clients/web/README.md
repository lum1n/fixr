# @fixr/web

Embeddable "fix this UI" reporter for web apps. Press **⌘⇧F** (Ctrl+Shift+F on other
platforms), black out anything sensitive on the screenshot, type what should change, and the
report goes to your fixr Worker in the background. The [wire format](../../spec/wire-format.md)
is the contract; this package implements it for browsers.

- TypeScript, zero runtime dependencies. ESM build plus an IIFE build for script tags (`window.Fixr`).
- [`html-to-image`](https://github.com/bubkoo/html-to-image) is an **optional** peer dependency,
  loaded with a dynamic `import()` only when a DOM screenshot is taken.
- Fire and forget: each report is written to IndexedDB before it is sent and retried with
  backoff until the Worker accepts it.

## Install

```sh
pnpm add @fixr/web html-to-image   # html-to-image only for capture: "dom" (the default)
```

```ts
import { init } from "@fixr/web";

const fixr = init({
  endpoint: "https://fixr.example.workers.dev", // or the full .../v1/reports URL
  projectKey: "pk_live_…",
  appVersion: import.meta.env.VITE_APP_VERSION,
  metadata: () => ({ branch: "main", user_tier: "beta" }), // → report.extra
});
```

Script tag (the IIFE build has html-to-image inlined, because a script tag cannot resolve a bare
`import()`):

```html
<script src="https://unpkg.com/@fixr/web/dist/fixr.global.js"></script>
<script>
  Fixr.init({ endpoint: "https://fixr.example.workers.dev", projectKey: "pk_live_…" });
</script>
```

## API

`init(options) → { open, send, flush, destroy }`

| option        | default           | meaning |
|---------------|-------------------|---------|
| `endpoint`    | required          | Worker base URL; `/v1/reports` is appended unless it is already there. |
| `projectKey`  | required          | Sent as `Authorization: Bearer <projectKey>`. |
| `hotkey`      | `"mod+shift+f"`   | `mod` is ⌘ on Apple platforms, Ctrl elsewhere. `false` disables it. |
| `capture`     | `"dom"`           | `"dom"`, `"display"`, `"none"`, or `({ host }) => Blob \| canvas \| img \| ImageBitmap \| null`. |
| `metadata`    | –                 | Object or (async) function; becomes `extra` (≤ 32 keys, values stringified, ≤ 1000 chars). |
| `limits`      | spec limits       | Override `maxPromptLength`, `maxLongEdge`, `maxImageBytes`, `minLongEdge`, … (keep the defaults unless your Worker differs). |
| `appId`       | `location.host`   | `app.id`. |
| `appVersion`, `appBuild` | –      | `app.version`, `app.build`. |
| `screen`      | –                 | `() => string`, sent as `context.screen` (route or view name). |
| `sdkHeader`   | `true`            | Send `X-Fixr-SDK: fixr-web/0.1.0` (see below). |
| `onEvent`     | –                 | `({type: "queued" \| "delivered" \| "retry" \| "dropped", id, …}) => void`. |
| `dbName`      | `"fixr"`          | IndexedDB database name. |

- `open()` captures the page **first**, then shows the dialog. Resolves with the report id once it
  is queued, or `null` when cancelled.
- `send(prompt, { screenshot?, screenshotOmittedReason?, redactions?, extra? })` queues a report
  without UI. `screenshot: undefined` captures per `capture`; `null` sends none.
- `flush()` attempts every queued report now, ignoring backoff.
- `destroy()` removes listeners, timers and the dialog. Queued reports stay in IndexedDB.

### Identifying the SDK

The wire format asks for `User-Agent: fixr-<sdk>/<semver>`, but browsers do not let scripts set
`User-Agent`. The web SDK sends **`X-Fixr-SDK: fixr-web/0.1.0`** instead (and `sdk.name` /
`sdk.version` are in the report as always). Because it is a non-safelisted header, the Worker's
CORS preflight response must list it:

```
Access-Control-Allow-Origin: <your app origin or *>
Access-Control-Allow-Headers: authorization, content-type, idempotency-key, x-fixr-sdk
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Expose-Headers: retry-after
```

`Expose-Headers: retry-after` lets the SDK honour `Retry-After` on cross-origin 429/503s. The fixr Worker and
`spec/echo-server` send these. Pass `sdkHeader: false` for a server whose allow-list lacks the header.

## Capture

| mode       | how | caveats |
|------------|-----|---------|
| `dom`      | html-to-image `toPng` of `document.documentElement`, cropped to the viewport at the current scroll position. | A re-render, not pixels: cross-origin images/fonts without CORS are skipped, WebGL canvases need `preserveDrawingBuffer`, iframes and video come out blank. No permission prompt. |
| `display`  | `getDisplayMedia({ preferCurrentTab: true })`, one frame, then every track is stopped. | True pixels, but the browser asks every time; not on iOS Safari. |
| `none`     | No screenshot; `screenshot_omitted_reason: "capture_disabled"`. | |
| function   | Yours. Return `null` for none. | |

The fixr host element and anything with **`data-fixr-ignore`** are left out of DOM captures (the
element is removed from the rendered clone, so later content moves up into its space). A capture
that throws sends `screenshot_omitted_reason: "capture_failed"`; removing the screenshot in the
dialog sends `user_removed`.

## Dialog

A `<fixr-report>` custom element with a shadow root (so page CSS does not leak in): screenshot
preview on a canvas where dragging draws black rectangles (burned into the image on Send),
**Undo**, **Remove screenshot**, a textarea (1–4000 characters), **Cancel** / **Send**.
Esc closes, ⌘/Ctrl+Enter sends, Tab is trapped inside, focus returns to where it was, and the
colours follow `prefers-color-scheme`.

## Image ladder

Exactly as in the spec, on a canvas (`OffscreenCanvas` where it can encode): long edge ≤ 2000 px;
PNG if ≤ 2 MB, else JPEG at 0.9, 0.8, 0.7, 0.6, 0.5; still too big → ×0.75 and repeat; below
200 px long edge → no image, `screenshot_omitted_reason: "too_large"`. The ladder
(`prepareImage`) talks to an `ImageEncoder` interface, so tests drive it with a fake encoder.

## Delivery

1. On Send the report (and the encoded image `Blob`) is written to IndexedDB (`fixr` / `reports`).
2. It is posted with `fetch` as `multipart/form-data` (`report` part `application/json`, then
   `screenshot` part `screenshot.png|jpg`), with `Authorization`, `Idempotency-Key: <report.id>`
   and `X-Fixr-SDK`.
3. `201`/`200` → deleted. `400/401/403/413/422` and other 4xx → dropped. `408`, `429`, `5xx` and
   network errors → kept with `attempts` and `nextAttemptAt`; retried after 30 s, 2 min, 10 min,
   1 h, 6 h, then daily (a longer `Retry-After` on 429/503 wins). Dropped after 20 attempts or
   7 days after `created_at`.
4. The queue drains on `init`, on `online`, when the tab becomes visible, and on a timer armed for
   the next due report. Nothing is attempted while `navigator.onLine` is false.
5. On `pagehide` while an upload is in flight, the SDK fires a `keepalive` fetch with the
   `application/json` body variant **without** the screenshot (keepalive bodies are capped at
   64 KiB) and the same `Idempotency-Key`. The stored copy stays queued; if the keepalive got
   through, the next page load receives `200 duplicate` for it and deletes it (the screenshot is
   then lost, the prompt is not).

If IndexedDB is unavailable the queue falls back to memory for the lifetime of the page.

## Metadata

`device.platform` is `web`; `device.os_version` comes from UA Client Hints
(`platform` + `platformVersion`) when available, else from `navigator.userAgent`;
`device.screen` is `innerWidth` × `innerHeight` in CSS px with `scale = devicePixelRatio`;
`locale` is `navigator.language`; `context.url` is `location.href`, `context.title` is
`document.title`.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test        # vitest + jsdom, fake-indexeddb
pnpm build       # dist/index.js (ESM + .d.ts), dist/fixr.global.js (IIFE, window.Fixr)
pnpm e2e         # Playwright (Chromium) against spec/echo-server; run pnpm build first
```

Unit tests cover the golden report (`spec/fixtures/report.v1.json`), the multipart and JSON body
shapes, response classification, the retry schedule and give-up rules on a fake clock, the image
ladder with a fake encoder, IndexedDB persistence and drain, the keepalive fallback, and the dialog
(hotkey, Esc, focus trap, Send).

### Demo

```sh
pnpm build
node ../../spec/echo-server/server.mjs --port 8787 --out ./out   # terminal 1 (or: pnpm echo)
node demo/serve.mjs --port 8788                                  # terminal 2 (or: pnpm demo)
open http://localhost:8788/demo/
```

Query parameters: `endpoint` (default `http://localhost:8787`), `key`, `capture`
(`dom` | `display` | `none`), `sdkHeader=0`. Reports land in `out/<id>.json` and
`out/<id>.png|jpg`. Try `--fail-first 2` on the echo server and watch the retry events in the log
on the page (**Flush queue** skips the wait).

The e2e suite starts its own servers on ports 18901–18903 so it does not clash with a running echo
server.
