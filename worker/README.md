# fixr Worker

Cloudflare Worker that takes reports from the fixr clients and hands them to
`fixr-runner` as jobs. The HTTP contract is [`../spec/wire-format.md`](../spec/wire-format.md).

- `POST /v1/reports` (project key): multipart or JSON, stored in D1 (`jobs`) and R2 (`jobs/<id>.png|jpg`).
- `GET /v1/runner/next?wait=N`, `GET /v1/runner/jobs/:id`, `POST /v1/runner/jobs/:id/status`,
  `GET /v1/runner/jobs/:id/screenshot?exp=&sig=` (runner token).
- `POST /v1/hooks/acc?token=<hook_token>`: acc `HostEvent` webhook.
- Cron every 5 minutes: `claimed` jobs older than 10 minutes go back to `queued`.

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test             # vitest in workerd (miniflare D1/R2), migrations applied in test/setup.ts
cp .dev.vars.example .dev.vars
pnpm migrate:local
pnpm add-project --id notes --repo-path ~/repos/notes --local
pnpm dev
```

## Set up and deploy

```sh
pnpm exec wrangler d1 create fixr            # put the database_id in wrangler.jsonc
pnpm exec wrangler r2 bucket create fixr-screenshots
pnpm exec wrangler secret put RUNNER_TOKEN   # e.g. openssl rand -hex 32; same value in runner.toml
pnpm exec wrangler secret put HOOK_TOKEN     # goes in the webhook URL the runner gives acc
pnpm migrate:remote
pnpm add-project --id notes --repo-path ~/repos/notes --base-branch main \
  --harness claude --permission bypassPermissions --model opus --remote
pnpm deploy
```

`add-project` prints the project key once; only its sha256 is stored. Use
`--print-sql` to get the SQL without running `wrangler`.
