import { Hono } from 'hono'

import { requireHookToken } from '../lib/auth'
import type { Bindings, JobRow } from '../lib/env'
import { badRequest, unprocessable } from '../lib/errors'
import { type JobPatch, updateJob } from '../lib/jobs'
import { type HostEvent, hostEventSchema } from '../schema/hook'

/** The state table in wire-format.md; null means "leave the job alone". */
export function patchForEvent(event: HostEvent, job: Pick<JobRow, 'state'>): JobPatch | null {
  switch (event.state) {
    case 'blocked': {
      const detail = [event.kind, event.detail].filter((s) => s !== undefined && s !== '').join(': ')
      return detail ? { state: 'blocked', detail } : { state: 'blocked' }
    }
    case 'done':
      return job.state === 'done' ? null : { state: 'done' }
    case 'error':
      return event.detail !== undefined ? { state: 'error', detail: event.detail } : { state: 'error' }
    case 'exited':
      if (job.state === 'done') return null
      return { state: 'error', detail: `exited with code ${event.code ?? 'unknown'}` }
  }
}

export function createHookRoutes() {
  const app = new Hono<{ Bindings: Bindings }>()

  app.post('/v1/hooks/acc', async (c) => {
    await requireHookToken(c)
    // acc posts with curl's default content type or none; parse the text ourselves.
    const text = await c.req.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw badRequest('invalid_json')
    }
    const parsed = hostEventSchema.safeParse(body)
    if (!parsed.success) {
      throw unprocessable(
        'invalid_event',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      )
    }
    const event = parsed.data

    const job = await c.env.DB.prepare(
      'SELECT id, state FROM jobs WHERE session_id = ?1 ORDER BY created_at DESC LIMIT 1',
    )
      .bind(event.session)
      .first<Pick<JobRow, 'id' | 'state'>>()
    if (!job) return c.json({ ignored: true }, 202)

    const patch = patchForEvent(event, job)
    if (!patch) return c.json({ id: job.id, state: job.state })
    const updated = await updateJob(c.env.DB, job.id, patch)
    return c.json({ id: job.id, state: updated?.state ?? job.state })
  })

  return app
}
