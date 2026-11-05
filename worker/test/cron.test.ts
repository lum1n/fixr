import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

import worker from '../src/index'
import { isoSeconds } from '../src/lib/time'
import { insertJob, newId, seedProject } from './helpers'

beforeEach(async () => {
  await seedProject()
})

describe('scheduled', () => {
  it('returns claimed jobs older than 10 minutes to queued', async () => {
    const now = Date.now()
    const stale = newId()
    const fresh = newId()
    const running = newId()
    await insertJob(stale, { state: 'claimed', claimed_at: isoSeconds(now - 11 * 60_000) })
    await insertJob(fresh, { state: 'claimed', claimed_at: isoSeconds(now - 5 * 60_000) })
    await insertJob(running, { state: 'running', claimed_at: isoSeconds(now - 60 * 60_000) })

    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ scheduledTime: now, cron: '*/5 * * * *' }), env, ctx)
    await waitOnExecutionContext(ctx)

    const states = await env.DB.prepare('SELECT id, state, claimed_at FROM jobs').all<{ id: string; state: string; claimed_at: string | null }>()
    const byId = Object.fromEntries(states.results.map((r) => [r.id, r]))
    expect(byId[stale]).toMatchObject({ state: 'queued', claimed_at: null })
    expect(byId[fresh]).toMatchObject({ state: 'claimed' })
    expect(byId[running]).toMatchObject({ state: 'running' })
  })
})
