import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

import { signScreenshot } from '../src/lib/signing'
import { call, insertJob, newId, png, postMultipart, report, RUNNER, seedProject } from './helpers'

beforeEach(async () => {
  await seedProject()
})

async function submitWithScreenshot(id: string, image = png(10, 10)) {
  const res = await postMultipart(report({ id }), {
    name: 'screenshot',
    filename: 'screenshot.png',
    contentType: 'image/png',
    data: image,
  })
  expect(res.status).toBe(201)
}

describe('auth', () => {
  it('requires the runner token', async () => {
    expect((await call('/v1/runner/next')).status).toBe(401)
    expect((await call('/v1/runner/next', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await call(`/v1/runner/jobs/${newId()}`)).status).toBe(401)
    expect((await call(`/v1/runner/jobs/${newId()}/status`, { method: 'POST', body: '{}' })).status).toBe(401)
  })
})

describe('GET /v1/runner/next', () => {
  it('returns 204 when nothing arrives within wait', async () => {
    const started = Date.now()
    const res = await call('/v1/runner/next?wait=1', { headers: RUNNER })
    expect(res.status).toBe(204)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  it('returns 204 immediately without wait and rejects a bad wait', async () => {
    expect((await call('/v1/runner/next', { headers: RUNNER })).status).toBe(204)
    expect((await call('/v1/runner/next?wait=abc', { headers: RUNNER })).status).toBe(400)
  })

  it('returns the job, project and a signed screenshot URL', async () => {
    const id = newId()
    await submitWithScreenshot(id)
    const res = await call('/v1/runner/next?wait=1', { headers: RUNNER })
    expect(res.status).toBe(200)
    const body = await res.json<Record<string, any>>()
    expect(Object.keys(body)).toEqual(['job', 'project', 'screenshot_url'])
    expect(Object.keys(body.job)).toEqual(['id', 'report', 'screenshot_mime', 'created_at'])
    expect(body.job).toMatchObject({ id, report: report({ id }), screenshot_mime: 'image/png' })
    expect(body.job.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(body.project).toEqual({
      id: 'notes',
      repo_path: '~/repos/notes',
      base_branch: 'main',
      harness: 'claude',
      permission: 'bypassPermissions',
      model: 'opus',
    })
    expect(body.screenshot_url).toMatch(
      new RegExp(`^https://fixr\\.test/v1/runner/jobs/${id}/screenshot\\?exp=\\d+&sig=[0-9a-f]{64}$`),
    )
    const row = await env.DB.prepare('SELECT state, claimed_at FROM jobs WHERE id = ?1').bind(id).first()
    expect(row).toMatchObject({ state: 'claimed' })
  })

  it('returns null screenshot fields and model when absent', async () => {
    await env.DB.prepare("UPDATE projects SET model = NULL WHERE id = 'notes'").run()
    const id = newId()
    expect((await postMultipart(report({ id }))).status).toBe(201)
    const body = await (await call('/v1/runner/next', { headers: RUNNER })).json<Record<string, any>>()
    expect(body.job.screenshot_mime).toBeNull()
    expect(body.screenshot_url).toBeNull()
    expect(body.project.model).toBeNull()
  })

  it('hands out jobs oldest first', async () => {
    const a = newId()
    const b = newId()
    await insertJob(b, { created_at: '2026-11-05T14:00:05Z' })
    await insertJob(a, { created_at: '2026-11-05T14:00:01Z' })
    const first = await (await call('/v1/runner/next', { headers: RUNNER })).json<Record<string, any>>()
    const second = await (await call('/v1/runner/next', { headers: RUNNER })).json<Record<string, any>>()
    expect([first.job.id, second.job.id]).toEqual([a, b])
  })

  it('claims a job once even with two concurrent polls', async () => {
    const id = newId()
    const polls = [call('/v1/runner/next?wait=2', { headers: RUNNER }), call('/v1/runner/next?wait=2', { headers: RUNNER })]
    await new Promise((r) => setTimeout(r, 200))
    await insertJob(id)
    const results = await Promise.all(polls)
    expect(results.map((r) => r.status).sort()).toEqual([200, 204])
    const winner = results.find((r) => r.status === 200)!
    expect((await winner.json<Record<string, any>>()).job.id).toBe(id)
  })

  it('picks up a job that arrives during the wait', async () => {
    const id = newId()
    const poll = call('/v1/runner/next?wait=3', { headers: RUNNER })
    await new Promise((r) => setTimeout(r, 300))
    await insertJob(id)
    const res = await poll
    expect(res.status).toBe(200)
  })
})

describe('screenshot URL', () => {
  async function claimedUrl(): Promise<{ id: string; url: URL; image: Uint8Array }> {
    const id = newId()
    const image = png(20, 20, 512)
    await submitWithScreenshot(id, image)
    const body = await (await call('/v1/runner/next', { headers: RUNNER })).json<Record<string, any>>()
    return { id, url: new URL(body.screenshot_url), image }
  }

  it('serves the image on a valid signature without a bearer', async () => {
    const { url, image } = await claimedUrl()
    const res = await call(`${url.pathname}${url.search}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(image)
  })

  it('rejects a bad or expired signature', async () => {
    const { id, url } = await claimedUrl()
    const exp = url.searchParams.get('exp')!
    expect((await call(`${url.pathname}?exp=${exp}&sig=${'0'.repeat(64)}`)).status).toBe(401)
    expect((await call(`${url.pathname}?exp=${Number(exp) + 1}&sig=${url.searchParams.get('sig')}`)).status).toBe(401)
    expect((await call(url.pathname)).status).toBe(401)
    const past = Math.floor(Date.now() / 1000) - 1
    const sig = await signScreenshot('test-runner-token', id, past)
    expect((await call(`${url.pathname}?exp=${past}&sig=${sig}`)).status).toBe(401)
  })

  it('accepts the runner bearer instead of a signature', async () => {
    const { url } = await claimedUrl()
    expect((await call(url.pathname, { headers: RUNNER })).status).toBe(200)
  })

  it('is valid for 15 minutes', async () => {
    const { url } = await claimedUrl()
    const exp = Number(url.searchParams.get('exp'))
    const now = Math.floor(Date.now() / 1000)
    expect(exp - now).toBeGreaterThanOrEqual(899)
    expect(exp - now).toBeLessThanOrEqual(900)
  })
})

describe('job status', () => {
  function postStatus(id: string, body: unknown) {
    return call(`/v1/runner/jobs/${id}/status`, {
      method: 'POST',
      headers: { ...RUNNER, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('updates state and keeps omitted members', async () => {
    const id = newId()
    await insertJob(id, { state: 'claimed' })

    const running = await postStatus(id, { state: 'running', session_id: 'claude-abc' })
    expect(running.status).toBe(200)
    expect(await running.json()).toEqual({ id, state: 'running' })

    const done = await postStatus(id, { state: 'done', pr_url: 'https://github.com/o/r/pull/1' })
    expect(await done.json()).toEqual({ id, state: 'done' })

    const res = await call(`/v1/runner/jobs/${id}`, { headers: RUNNER })
    expect(res.status).toBe(200)
    const job = await res.json<Record<string, unknown>>()
    expect(Object.keys(job)).toEqual(['id', 'state', 'session_id', 'pr_url', 'detail', 'updated_at'])
    expect(job).toMatchObject({
      id,
      state: 'done',
      session_id: 'claude-abc',
      pr_url: 'https://github.com/o/r/pull/1',
      detail: null,
    })
  })

  it('returns 404 for an unknown job and 422 for a bad state', async () => {
    expect((await postStatus(newId(), { state: 'running' })).status).toBe(404)
    expect((await call(`/v1/runner/jobs/${newId()}`, { headers: RUNNER })).status).toBe(404)
    const id = newId()
    await insertJob(id)
    expect((await postStatus(id, { state: 'queued' })).status).toBe(422)
    expect((await postStatus(id, { state: 'running', extra: 1 })).status).toBe(422)
  })
})
