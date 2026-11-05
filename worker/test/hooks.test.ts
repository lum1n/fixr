import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

import { call, HOOK_TOKEN, insertJob, newId, seedProject } from './helpers'

beforeEach(async () => {
  await seedProject()
})

function hook(event: Record<string, unknown>, token = HOOK_TOKEN) {
  // acc posts the line with curl; no auth header.
  return call(`/v1/hooks/acc?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ at: 1793890688, offset: 1234, ...event }),
  })
}

async function job(id: string) {
  return env.DB.prepare('SELECT state, detail FROM jobs WHERE id = ?1').bind(id).first<{ state: string; detail: string | null }>()
}

async function runningJob(session: string) {
  const id = newId()
  await insertJob(id, { state: 'running', session_id: session })
  return id
}

describe('POST /v1/hooks/acc', () => {
  it('requires the hook token', async () => {
    expect((await hook({ session: 's', state: 'done' }, 'wrong')).status).toBe(401)
    expect(
      (await call('/v1/hooks/acc', { method: 'POST', body: JSON.stringify({ at: 1, session: 's', state: 'done', offset: 0 }) }))
        .status,
    ).toBe(401)
  })

  it('ignores unknown sessions with 202', async () => {
    expect((await hook({ session: 'claude-unknown', state: 'done' })).status).toBe(202)
  })

  it('maps blocked with "<kind>: <detail>"', async () => {
    const id = await runningJob('claude-b')
    const res = await hook({ session: 'claude-b', state: 'blocked', kind: 'permission', detail: 'Bash' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id, state: 'blocked' })
    expect(await job(id)).toEqual({ state: 'blocked', detail: 'permission: Bash' })
  })

  it('maps done, then keeps done when exited arrives', async () => {
    const id = await runningJob('claude-d')
    await hook({ session: 'claude-d', state: 'done' })
    expect(await job(id)).toMatchObject({ state: 'done' })
    const exited = await hook({ session: 'claude-d', state: 'exited', code: 0 })
    expect(exited.status).toBe(200)
    expect(await job(id)).toEqual({ state: 'done', detail: null })
  })

  it('maps exited before done to error with the exit code', async () => {
    const id = await runningJob('claude-x')
    await hook({ session: 'claude-x', state: 'exited', code: 137 })
    expect(await job(id)).toEqual({ state: 'error', detail: 'exited with code 137' })
  })

  it('maps error with the event detail', async () => {
    const id = await runningJob('claude-e')
    await hook({ session: 'claude-e', state: 'error', detail: 'rate limited' })
    expect(await job(id)).toEqual({ state: 'error', detail: 'rate limited' })
  })

  it('rejects an unknown event state with 422', async () => {
    await runningJob('claude-z')
    expect((await hook({ session: 'claude-z', state: 'sleeping' })).status).toBe(422)
  })
})
