# fixr: embeddable "fix this UI" reporter → agent via acc

## Context

While using one of your own apps (iOS, macOS, web, gpui) you spot a bug or want a tweak. You want a trigger that takes a prompt plus a screenshot and fires it, without waiting, at a coding agent that opens a PR. The agent is launched through **acc** (`~/repos/acc`, `git@github.com:lum1n/acc.git`), your Rust library that runs Claude Code and other harnesses detached on a host.

Key fact from exploration: acc has **no network API**. It is a Rust crate (`acc-core`, `acc-ssh`) that generates POSIX scripts and runs them locally or over SSH. So a Cloudflare Worker can't talk to acc directly; something Rust must link `acc-core` on the agent host. Decisions taken with you:

- **Ingress:** Cloudflare Worker (Hono + zod, like `~/repos/email-service`).
- **Runner:** Rust daemon on this Linux box, linking `acc-core` with `Host::local()`. Long-polls the Worker; no inbound ports.
- **Clients v1:** Swift (iOS+macOS), Web (TS), gpui (Rust crate), plus a CLI.
- **Repo mapping:** app sends a project key; Worker maps key → repo path, base branch, harness, permission mode.
- **Outcome:** agent works in a git worktree on a branch and opens a PR.

Rust is the right choice for the runner, the shared client core, the gpui crate and the CLI. The Worker is TS by necessity; iOS/macOS SDK is Swift by necessity.

## Architecture

```
iOS/macOS app ─┐
web app        ├─ POST /v1/reports ──► Worker (Hono) ──► D1 (jobs) + R2 (screenshots)
gpui app       │                            ▲   │
fixr CLI      ─┘                            │   └─ GET /v1/runner/next (long-poll, runner token)
                                            │
                         POST /v1/runner/jobs/:id/status ◄── fixr-runner (Rust, this box)
                                                                 │ acc-core, Host::local()
                                                                 ├─ worktree::add_script → ~/.acc/w/<id>
                                                                 ├─ Session::launch(LaunchRequest{prompt, attachments, worktree, permission})
                                                                 └─ watch_exec(Hook::Webhook{Worker URL}) → done/blocked/error/exited
```

Fire and forget: the client's job ends at the Worker's 201. Everything after is async.

## Repo layout (Cargo workspace + pnpm for TS)

```
fixr/
  Cargo.toml                 workspace: crates/*
  spec/                      wire-format.md, report.schema.json, fixtures/report.v1.json, echo-server/server.mjs
  crates/
    fixr-client/             Report types, image resize/encode, multipart, HTTP post, disk retry queue (shared by cli, gpui, runner types)
    fixr-cli/                `fixr "prompt" --image x.png` (binary `fixr`)
    fixr-gpui/               gpui action + overlay + capture, depends on fixr-client
    fixr-runner/             daemon (binary `fixr-runner`): poll Worker, drive acc-core, report status
  worker/                    Cloudflare Worker (Hono, zod, D1, R2, vitest) — mirrors ~/repos/email-service layout
  clients/
    swift/                   SwiftPM package `Fixr` (iOS 17+, macOS 14+)
    web/                     npm `@fixr/web` (TS, shadow-DOM dialog)
  deploy/fixr-runner.service systemd user unit
  README.md
```

## Wire format (spec/wire-format.md + spec/report.schema.json)

`POST /v1/reports`. Headers: `Authorization: Bearer <project_key>`, `Idempotency-Key: <report.id>` (UUID v4, generated client-side, identical on every retry; Worker dedups via UNIQUE column), `User-Agent: fixr-<sdk>/<semver>`.

Body is `multipart/form-data` with exactly two parts (default on every client), or `application/json` with `"screenshot": {"mime","data":<base64>}` (CLI `--json`, web fallback):
- `report` — `application/json` document below, without screenshot
- `screenshot` — optional `image/png`|`image/jpeg`

Report document (`schema: 1`): `id, created_at, prompt, sdk{name,version}, app{id,version,build}, device{platform: ios|macos|web|linux|windows, os_version, model, screen{width,height,scale}}, locale, context{screen,title,url}, screenshot_omitted_reason, extra{string→string, ≤32 keys}`. Required: `schema,id,created_at,prompt,sdk,app.id,device.platform`.

Limits, identical on all clients and enforced by the Worker: image long edge ≤ 2000 px and ≤ 2 MB (PNG first, then JPEG quality ladder 0.9→0.5, then downscale ×0.75 and repeat); prompt ≤ 4000 chars; body ≤ 2.5 MiB.

Responses clients rely on: `201 {"id"}` delivered; `200` duplicate key (treat as delivered); `400/401/403/413/422` permanent → drop; `408/429/5xx`/network → retry with backoff 30s, 2m, 10m, 1h, 6h, then daily; give up after 20 attempts or 7 days.

Shared test assets: `spec/fixtures/report.v1.json` golden document (every SDK has a serialization test against it) and `spec/echo-server/server.mjs`, a zero-dep Node echo server (`--port 8787 --status 500 --fail-first N --delay-ms`) that writes `out/<id>.{json,png}`. All client verification points at it.

Runner API (header `Authorization: Bearer <runner_token>`):
- `GET /v1/runner/next?wait=25` → `200 {job, project, screenshot_url(signed)}` or `204`
- `POST /v1/runner/jobs/:id/status` body `{state: "claimed"|"running"|"done"|"blocked"|"error", session_id?, pr_url?, detail?}`
- `POST /v1/hooks/acc` — target of acc `Hook::Webhook`; body is acc `HostEvent {at, session, state, kind?, detail?, code?, offset}`; maps session → job via D1.

## Worker (worker/)

Files: `src/index.ts` (Hono app), `src/routes/reports.ts`, `src/routes/runner.ts`, `src/routes/hooks.ts`, `src/schema/*.ts` (zod), `src/lib/auth.ts` (constant-time key compare; keys hashed in D1), `migrations/0001_init.sql`, `wrangler.jsonc`, `test/*.test.ts`.

D1 tables: `projects(id, key_hash, repo_path, base_branch, harness, permission, model, created_at)`, `jobs(id PRIMARY KEY = report.id, project_id, report_json, screenshot_key, state, session_id, pr_url, detail, created_at, updated_at)`. Reports route validates the `report` part with zod generated from `spec/report.schema.json`, stores the screenshot in R2 under `jobs/<id>.<ext>`, and replies `201 {"id"}` or `200` on a duplicate id.

Long-poll: `GET /v1/runner/next` loops up to `wait` seconds checking D1 for `state='queued'`, atomically updates to `claimed` with a claim token. Simpler than Queues and keeps the runner a plain HTTP client. Stale `claimed` jobs older than N minutes go back to `queued` (cron trigger).

Project config lives in D1 (seeded by a `scripts/add-project.ts` using wrangler d1 execute) so repo path/branch never travel from untrusted clients.

## Runner (crates/fixr-runner)

Deps: `acc-core` (features `host`), `acc-ssh` (for `Host`), `tokio`, `reqwest`, `serde`, `image` (sanity decode), `tracing`. Git deps on `acc` by tag (`v0.3.0`) since it is `publish = false`.

Loop:
1. `GET /v1/runner/next` (long-poll). On job: download screenshot from the signed R2 URL.
2. Build prompt text from a template (`templates/report.md`): user prompt, metadata block, instructions: "work on the current branch of this worktree, commit, open a PR against `<base_branch>` with `gh pr create`, include the screenshot context in the PR body; do not ask questions, make reasonable assumptions and note them".
3. `host = Host::local()`. `id = new_session_id(Harness::Claude, &rand)`. Run `worktree::add_script(repo_path, id, Some(base_branch))` via `host.exec`; the script prints the worktree dir → `cwd`.
4. `Session::launch(LaunchRequest { harness, cwd, prompt: Some(text), attachments: vec![Attachment::from_bytes("image/png", &png)], title: Some(short prompt), labels: {source: fixr, job: id}, worktree: Some(id), permission: project.permission (e.g. "acceptEdits"/"bypassPermissions"), model, sandbox: Some(Sandbox{preset, write: [worktree], show_credentials: true for gh}), .. }, &id, "fixr", now_ms)` (`acc-core/src/session.rs:357`). `host.exec(launch_exec)`, then `host.exec(session.input_exec(session.take_transmit()))` (`session.rs:596`, `:873`). For Claude/pi that is the whole handshake; for Codex/ACP, follow the log until the pending prompt is sent (defer; v1 supports Claude only, enum left open).
5. `host.exec(session.watch_exec(Some(&Hook::Webhook{url: WORKER/v1/hooks/acc})))` (`session.rs:604`, `watch.rs:27`) so the Worker learns `done`/`blocked`/`error`/`exited` without the runner staying attached.
6. `POST status {claimed→running, session_id}`. On `done` webhook the Worker marks the job done; runner optionally runs a `gh pr list --head acc/<id>` to fill `pr_url` (or the hook handler asks the runner via next poll; keep v1 simple: runner polls `jobs/:id` for `done` then looks up the PR).

Concurrency: `max_parallel` setting (default 2); one tokio task per job. Systemd user unit `deploy/fixr-runner.service`. Config `~/.config/fixr/runner.toml`: worker URL, runner token, max_parallel, default harness.

Reuse: `acc_core::session`, `acc_core::worktree::add_script` (`worktree.rs:68`), `acc_core::watch::Hook`, `acc_core::command::Attachment` (`command.rs:77`, enforces 5 MiB/10 MiB), `acc_ssh::Host::local()` (`host.rs:199`) and `Host::exec` (`host.rs:371`). Pattern reference: `crates/acc-cli/src/run.rs:52`.

## Clients

### crates/fixr-client (shared Rust core; used by CLI, gpui, and reused for types by the runner)
Deps: `serde`, `serde_json`, `image` (png+jpeg only), `ureq` (rustls, no tokio), `uuid`, `time`, `dirs`. Modules: `report.rs` (types + builder), `image.rs` (`prepare_image` resize/encode ladder), `multipart.rs` (~60 lines, no crate), `transport.rs` (`Client::send → Outcome::{Delivered, RetryLater, Dropped}`), `queue.rs` (`DiskQueue` at `<dir>/<id>/{report.json, screenshot.*, state.json}` with shared backoff table), `sender.rs` (background thread draining the queue; `submit` returns immediately = fire and forget), `metadata.rs` (`host_device_info`). Tests: golden fixture, multipart, image limits, queue with fake clock, transport against an in-test `TcpListener`.

### crates/fixr-cli (bin `fixr`)
`clap`. `fixr "<prompt>" [--image x.png] [--project KEY|$FIXR_PROJECT_KEY] [--endpoint URL|$FIXR_ENDPOINT] [--meta k=v]... [--json] [--dry-run]` and `fixr flush`. Exit codes: 0 delivered, 2 queued, 3 dropped, 64 usage. `--dry-run` prints the exact body, useful while building the Worker.

### clients/swift (SwiftPM `Fixr`, iOS 17+/macOS 14+, no deps)
- API: `Fixr.configure(FixrConfiguration{endpoint, projectKey, trigger, metadataProvider, allowRedaction, maxImageDimension, maxImageBytes})`, `Fixr.present()`, `Fixr.send(prompt:image:extra:)`, `Fixr.flush()`, `Fixr.handleEventsForBackgroundURLSession(identifier:completionHandler:)`.
- Trigger: iOS opt-in shake (swizzle `UIWindow.motionEnded`, or app forwards via `Fixr.handleMotion`), macOS app-local ⌘⇧F via `NSEvent.addLocalMonitorForEvents` (no global monitor: that needs Accessibility permission).
- Capture, no Screen Recording permission: **iOS** draw every window of the active `UIWindowScene` (sorted by level) with `drawHierarchy(in:afterScreenUpdates:false)` into one `UIGraphicsImageRenderer`; caveat: `CAMetalLayer` renders black unless host sets `framebufferOnly=false`, keyboard/status bar excluded. **macOS** `CGWindowListCreateImage(.null, .optionIncludingWindow, windowNumber, [.boundsIgnoreFraming,.bestResolution])` on the key window: composited pixels so Metal/WebView/SwiftUI are correct, and TCC does not gate capturing your own window; deprecated since 14 but works on 14/15; fall back to `contentView.cacheDisplay` if nil/transparent. Capture happens before the sheet is presented.
- UI: SwiftUI sheet (iOS `UIHostingController` pageSheet, macOS `beginSheet`/`NSPanel`) with preview, black-rect redaction canvas (burned in via `ImageRenderer`), prompt field, Send.
- Transport: multipart written to a file, uploaded with a background `URLSession` (`uploadTask(fromFile:)`, `sessionSendsLaunchEvents`), so it survives suspension. Disk queue in Application Support with attempts/nextAttemptAt; drained on configure, foreground, and completion.
- Metadata: bundle id, version/build, OS, `utsname.machine`/`hw.model`, screen bounds+scale, locale, top view controller class / key window title.
- `Example/` app for both platforms with a misaligned button and an `MTKView` to prove Metal capture.

### clients/web (npm `@fixr/web`, TS, zero runtime deps; `html-to-image` as optional peer loaded dynamically)
- API: `init({endpoint, projectKey, hotkey="mod+shift+f", capture: 'dom'|'display'|'none'|CaptureFn, metadata, limits}) → {open, send, flush, destroy}`. ESM + IIFE (`window.Fixr`) via tsup.
- Capture default **`html-to-image`** of `document.documentElement` with filter dropping the fixr host and `[data-fixr-ignore]`: no permission prompt, works everywhere; caveats: re-render not pixels, cross-origin assets without CORS skipped, WebGL needs `preserveDrawingBuffer`, iframes/video blank. `getDisplayMedia` (`preferCurrentTab`) opt-in: true pixels but a picker every time and no iOS Safari.
- UI: custom element with shadow root, preview + redaction canvas + textarea, Esc/focus trap, color-scheme aware.
- Fire and forget: `sendBeacon`/`keepalive` can't carry auth header or >64 KiB, so primary is plain `fetch`; report is written to IndexedDB before the request and deleted on 2xx, drained on `init`/`online`. On `pagehide` mid-upload, a `keepalive` fetch sends a screenshot-less duplicate with the same Idempotency-Key.
- Tests: vitest/jsdom (metadata, body vs golden, resize ladder, queue backoff); Playwright e2e against the echo server with `demo/index.html`.

### crates/fixr-gpui
- Verified in `~/.cargo/registry/.../gpui-pre-0.3.11`: `Window::render_to_image()` exists but only under `test-support` and only on macOS; gpui's `screen-capture` feature is display-level and needs Screen Recording. `Window` implements `HasWindowHandle` on macOS/X11/Wayland, so capture our own window natively.
- API: `init(cx, FixrConfig{endpoint, project_key, app_id, app_version, metadata, capture: CaptureStrategy, limits})`, `open_report(window, cx)`, actions `fixr::{OpenReport, SendReport, CancelReport, ToggleRedact}` bound to cmd/ctrl-shift-f.
- Capture behind `trait WindowCapturer`, features: `capture-macos` (default; `objc2-core-graphics` `CGWindowListCreateImage` on own window number, no permission), `capture-x11` (default on Linux; `x11rb` `GetImage` on own window), `capture-portal` (opt-in `ashpd` xdg portal screenshot for Wayland, interactive), `capture-gpui-render` (opt-in, enables `gpui/test-support`). Wayland default sends `screenshot_omitted_reason: "wayland_unsupported"`.
- Overlay: separate `WindowKind::PopUp` window (640×520) with preview `img`, redaction rects burned in on send, minimal multiline input (modelled on gpui's `input` example; feature `gpui-component` swaps in its `Input`). Capture runs on `OpenReport` before the overlay window exists.
- Upload via `fixr-client` `Sender` on a background thread. `examples/demo.rs` against the echo server. Pin the gpui version; keep capturers isolated to one file each because gpui drifts.

## Verification

- **Worker:** `pnpm test` (vitest, miniflare-backed D1/R2): auth rejects bad keys; multipart parse; idempotency dedup; long-poll claim is atomic; hook maps session→job. `wrangler dev` + `curl` smoke.
- **Runner:** unit-test prompt template and status mapping; integration test behind a feature flag that runs against a throwaway git repo with `acc` `Harness::Claude` and a tiny prompt ("add a comment to README") and asserts a worktree, a session dir under `~/.acc/s/<id>`, and a `done` HostEvent. Mock Worker with `wiremock`.
- **End to end:** `fixr "make the title bold" --image shot.png --project <key>` → job appears in D1 → runner launches → PR opened on the test repo.
- **Clients:** each points at `wrangler dev` locally; see per-client notes below.

## Milestones

1. Protocol doc + `fixr-proto` + Worker (reports, runner, hooks) + CLI. E2E with CLI.
2. Runner against acc, Claude only, with worktree + webhook. First real PR.
3. Swift package (macOS first, then iOS), then Web, then gpui.
4. Retry queues, status page (`GET /v1/jobs` for a tiny dashboard), Codex/ACP harness support.
