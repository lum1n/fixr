import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach } from 'vitest'

// Migrations are recorded in d1_migrations, so this applies them once per
// storage and then only clears rows. R2 keys are per-report ids.
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.batch([env.DB.prepare('DELETE FROM jobs'), env.DB.prepare('DELETE FROM projects')])
})
