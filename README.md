# fixr

An embeddable "fix this" reporter. While using one of your apps (iOS, macOS,
web, gpui, or the terminal), press a shortcut, black out anything private,
type what you want changed, and press Send. The report (prompt + screenshot +
app metadata) goes to a Cloudflare Worker; a runner on your machine picks it
up and starts a coding agent through [acc](https://github.com/lum1n/acc) in a
fresh git worktree. The agent commits and opens a PR.

Sending is fire and forget: the client's job ends at the Worker's `201`, and
undelivered reports wait in an on-device queue and are retried.

```
apps (Swift / web / gpui / CLI) ─POST /v1/reports─► Worker (Hono, D1, R2)
                                                        ▲  │ GET /v1/runner/next (long-poll)
                                  POST /v1/hooks/acc ───┘  ▼
                                                     fixr-runner (this machine)
                                                        └─ acc: worktree → Claude Code → PR
```

## Layout

| path | what |
|------|------|
| `spec/` | wire format (`wire-format.md`), JSON schema, golden fixture, zero-dep echo server |
| `worker/` | Cloudflare Worker: reports, runner API, acc webhook, cron requeue ([README](worker/README.md)) |
| `crates/fixr-client` | Rust core: report types, image ladder, multipart, transport, disk retry queue, background sender |
| `crates/fixr-cli` | `fixr` command |
| `crates/fixr-runner` | `fixr-runner` daemon driving acc on this machine |
| `crates/fixr-gpui` | gpui integration: shortcut, window capture, overlay ([README](crates/fixr-gpui/README.md)) |
| `clients/swift` | SwiftPM `Fixr` for iOS 17+ / macOS 14+ ([README](clients/swift/README.md)) |
| `clients/web` | npm `@fixr/web` ([README](clients/web/README.md)) |
| `deploy/` | systemd user unit and example runner config |

## Setup

1. **Worker**: follow [worker/README.md](worker/README.md) (create D1 + R2, set
   `RUNNER_TOKEN` and `HOOK_TOKEN`, apply migrations, deploy). Register each
   repository with `pnpm add-project` and keep the printed project key; the
   repo path, base branch, harness and permission mode live in D1 and never
   come from clients.
2. **Runner** (on the machine with your repos, `claude` and `gh` logged in):
   ```sh
   cargo install --path crates/fixr-runner
   mkdir -p ~/.config/fixr && cp deploy/runner.example.toml ~/.config/fixr/runner.toml  # fill in
   cp deploy/fixr-runner.service ~/.config/systemd/user/
   systemctl --user daemon-reload && systemctl --user enable --now fixr-runner
   ```
3. **Try it** from the terminal:
   ```sh
   cargo install --path crates/fixr-cli
   export FIXR_ENDPOINT=https://fixr.example.workers.dev FIXR_PROJECT_KEY=fixr_...
   fixr "make the title bold" --image shot.png
   ```
   Exit codes: 0 delivered, 2 queued (run `fixr flush` later), 3 dropped, 64 usage.
   `--dry-run` prints the exact request; `--json` sends the JSON body variant.
4. **Embed** one of the SDKs in your app (see each README).

## How a job runs

The runner claims a job, downloads the screenshot, fetches `origin/<base>`,
makes an acc worktree (`~/.acc/w/<session>`, branch `acc/<session>`), and
launches a detached Claude Code session there with the prompt from
`crates/fixr-runner/templates/report.md` and the screenshot attached. It
registers acc's watcher with a webhook to the Worker, follows the session's
events, and when the turn is done looks up the PR with `gh pr list --head
acc/<session>` and reports it. Sessions stay on disk, so `acc` can attach to
or resume one later.

Permission mode defaults to `bypassPermissions` (nobody is around to
approve), inside acc's `workspace` sandbox with git/gh credentials visible.
Set `sandbox = "none"` in `runner.toml` to run unconfined.

## Development

```sh
cargo test                                   # client, CLI, runner
cargo test -p fixr-gpui                      # gpui crate (not a default member)
cargo test -p fixr-runner --features e2e -- --nocapture   # real Claude session via acc
(cd worker && pnpm test)
(cd clients/web && pnpm test)
(cd clients/swift && swift test)
node spec/echo-server/server.mjs --port 8787 [--fail-first N] [--status 500]
```

Every SDK has a serialization test against `spec/fixtures/report.v1.json`.

## Not done yet

- Harnesses other than Claude Code and pi in the runner (Codex/ACP need the
  log followed until the session is up before the prompt goes in).
- Status dashboard (`GET /v1/jobs`).
- A runner restart loses track of in-flight jobs: the Worker still gets acc's
  webhook events, but `pr_url` isn't filled in for those jobs.
