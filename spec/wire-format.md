# fixr wire format, v1

Every client (Swift, web, gpui, CLI) and the Worker implement this document.
`report.schema.json` is the machine-readable form of the report document;
`fixtures/report.v1.json` is the golden document every SDK serializes in a test.

## Submitting a report

```
POST /v1/reports
Authorization: Bearer <project_key>
Idempotency-Key: <report.id>
User-Agent: fixr-<sdk>/<semver>
Content-Type: multipart/form-data; boundary=... | application/json
```

`Idempotency-Key` is the report's `id`, a lowercase UUID v4 generated on the
device when the user presses Send. It is identical on every retry. When the
header is present it must equal `report.id`.

### Body

**multipart/form-data** (default on every client), exactly these parts, in this order:

| name         | content type                 | required | content                              |
|--------------|------------------------------|----------|--------------------------------------|
| `report`     | `application/json`           | yes      | the report document, no screenshot   |
| `screenshot` | `image/png` or `image/jpeg`  | no       | the image bytes                      |

The `screenshot` part should carry a `filename` (`screenshot.png` / `screenshot.jpg`).

**application/json** (CLI `--json`, web fallback): the report document with one
extra member:

```json
"screenshot": { "mime": "image/png", "data": "<standard base64 with padding>" }
```

### Report document (`schema: 1`)

```json
{
  "schema": 1,
  "id": "0b9f6c1e-3c1a-4d2b-9a57-5f3d2c1b0a99",
  "created_at": "2026-11-05T14:03:12Z",
  "prompt": "The Save button is misaligned with Cancel.",
  "sdk":    { "name": "fixr-swift", "version": "0.1.0" },
  "app":    { "id": "com.example.notes", "version": "1.4.2", "build": "231" },
  "device": { "platform": "macos", "os_version": "15.1", "model": "Mac15,6",
              "screen": { "width": 1512, "height": 982, "scale": 2 } },
  "locale": "en-US",
  "context": { "screen": "EditorViewController", "title": "Untitled", "url": "https://..." },
  "screenshot_omitted_reason": "user_removed",
  "extra": { "branch": "main" }
}
```

Rules:

- Required: `schema`, `id`, `created_at`, `prompt`, `sdk.name`, `sdk.version`, `app.id`, `device.platform`.
- Optional members are **omitted** when unknown, never `null`. Unknown members are rejected.
- `created_at` is UTC with whole seconds, `YYYY-MM-DDTHH:MM:SSZ`.
- `device.platform` is one of `ios`, `macos`, `web`, `linux`, `windows`.
- `device.screen` is in points (CSS px on web); `scale` is the pixel ratio.
- `extra` is a flat string→string map, at most 32 keys, keys ≤ 64 chars, values ≤ 1000 chars.
- `screenshot_omitted_reason` (when no screenshot is attached): `user_removed`,
  `capture_failed`, `capture_disabled`, `wayland_unsupported`, `too_large`, or an SDK-specific token.

### Limits (identical on all clients; enforced by the Worker)

| what                | limit                       |
|---------------------|-----------------------------|
| prompt              | 1–4000 characters (Unicode scalar values) |
| image long edge     | ≤ 2000 px                   |
| image bytes         | ≤ 2 MB (2 000 000 bytes)    |
| request body        | ≤ 2.5 MiB (2 621 440 bytes) |

Image preparation ladder (every client does the same thing):

1. Downscale so the long edge is ≤ 2000 px (keep aspect ratio).
2. Encode PNG. If ≤ 2 MB, done.
3. Encode JPEG at quality 0.9, 0.8, 0.7, 0.6, 0.5; the first that fits wins.
4. Still too big: scale by ×0.75 and go to step 2. Give up below 200 px long edge
   and send `screenshot_omitted_reason: "too_large"`.

### Responses

| status | body                         | client action                    |
|--------|------------------------------|----------------------------------|
| 201    | `{"id": "<id>"}`             | delivered; delete from queue     |
| 200    | `{"id": "<id>", "duplicate": true}` | already delivered; delete  |
| 400, 401, 403, 413, 422 | `{"error": "...", "detail"?}` | permanent; drop     |
| 408, 429, 5xx, network error | —               | retry later                      |

Any other 4xx is permanent.

### Retry schedule

Delays after attempt *n* fails: 30 s, 2 min, 10 min, 1 h, 6 h, then every 24 h.
A report is dropped after 20 attempts or 7 days after `created_at`, whichever first.
A `Retry-After` header (seconds) on 429/503 overrides the next delay when it is longer.

## Runner API

`Authorization: Bearer <runner_token>` on every request.

### `GET /v1/runner/next?wait=<seconds ≤ 25>`

Long-polls for the oldest `queued` job and atomically marks it `claimed`.

- `204` — nothing within `wait` seconds.
- `200`:

```json
{
  "job": {
    "id": "0b9f6c1e-...",
    "report": { ...report document... },
    "screenshot_mime": "image/png",
    "created_at": "2026-11-05T14:03:12Z"
  },
  "project": {
    "id": "notes",
    "repo_path": "~/repos/notes",
    "base_branch": "main",
    "harness": "claude",
    "permission": "bypassPermissions",
    "model": "opus"
  },
  "screenshot_url": "https://fixr.example.workers.dev/v1/runner/jobs/<id>/screenshot?exp=1793890688&sig=<hex>"
}
```

`screenshot_mime` and `screenshot_url` are `null` when there is no screenshot;
`model` is `null` for the harness default. The URL is signed (HMAC-SHA256 of
`<id>.<exp>` with the runner token) and valid for 15 minutes; the bearer header
is also accepted on it.

### `GET /v1/runner/jobs/:id`

`200 {"id", "state", "session_id", "pr_url", "detail", "updated_at"}`.

### `POST /v1/runner/jobs/:id/status`

```json
{ "state": "running", "session_id": "claude-abc...", "pr_url": "https://github.com/...", "detail": "..." }
```

`state` is one of `claimed`, `running`, `done`, `blocked`, `error`. Other members optional;
omitted members leave the stored value unchanged. `200 {"id","state"}`; `404` unknown job.

### Job states

```
queued → claimed → running → done
                          ↘ blocked → running (an answer arrives) / error
                          ↘ error
```

A job `claimed` for more than 10 minutes without moving to `running` goes back to
`queued` (Worker cron, every 5 minutes).

## acc webhook

`POST /v1/hooks/acc?token=<hook_token>` — the URL the runner hands to acc's
`Hook::Webhook`. acc posts each `HostEvent` line as JSON with no headers, so the
secret rides in the query. Body:

```json
{ "at": 1793890688, "session": "claude-abc...", "state": "done", "kind": "permission", "detail": "Bash", "code": 0, "offset": 1234 }
```

The Worker maps `session` → job via `jobs.session_id` and applies:

| HostEvent `state` | job becomes                                          |
|-------------------|------------------------------------------------------|
| `blocked`         | `blocked`, detail = `"<kind>: <detail>"`             |
| `done`            | `done` (unless already `done`)                       |
| `error`           | `error`, detail from event                           |
| `exited`          | `error` with `exited with code N`, unless already `done` |

Unknown sessions get `202` and are ignored.
