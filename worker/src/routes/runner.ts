import { Hono } from 'hono'

import { isRunner, requireRunner } from '../lib/auth'
import type { Bindings, JobRow, Project } from '../lib/env'
import { badRequest, notFound, unauthorized, unprocessable } from '../lib/errors'
import { mimeForKey } from '../lib/image'
import { claimNextJob, getJob, updateJob } from '../lib/jobs'
import { screenshotUrl, verifyScreenshotSignature } from '../lib/signing'
import { sleep } from '../lib/time'
import { MAX_WAIT_SECONDS, statusUpdateSchema } from '../schema/runner'

export const POLL_INTERVAL_MS = 1000

async function jobResponse(origin: string, secret: string, job: JobRow, project: Project | null) {
  return {
    job: {
      id: job.id,
      report: JSON.parse(job.report_json) as unknown,
      screenshot_mime: job.screenshot_key ? mimeForKey(job.screenshot_key) : null,
      created_at: job.created_at,
    },
    project: project && {
      id: project.id,
      repo_path: project.repo_path,
      base_branch: project.base_branch,
      harness: project.harness,
      permission: project.permission,
      model: project.model,
    },
    screenshot_url: job.screenshot_key ? await screenshotUrl(origin, secret, job.id) : null,
  }
}

function parseWait(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0
  if (!/^\d+$/.test(raw)) throw badRequest('invalid_wait', 'wait must be a whole number of seconds')
  return Math.min(Number(raw), MAX_WAIT_SECONDS)
}

export function createRunnerRoutes() {
  const app = new Hono<{ Bindings: Bindings }>()

  app.get('/v1/runner/next', async (c) => {
    await requireRunner(c)
    const wait = parseWait(c.req.query('wait'))
    const deadline = Date.now() + wait * 1000

    for (;;) {
      const job = await claimNextJob(c.env.DB)
      if (job) {
        const project = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?1')
          .bind(job.project_id)
          .first<Project>()
        return c.json(await jobResponse(new URL(c.req.url).origin, c.env.RUNNER_TOKEN, job, project), 200)
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return c.body(null, 204)
      await sleep(Math.min(POLL_INTERVAL_MS, remaining))
    }
  })

  app.get('/v1/runner/jobs/:id', async (c) => {
    await requireRunner(c)
    const job = await getJob(c.env.DB, c.req.param('id'))
    if (!job) throw notFound('unknown_job')
    return c.json({
      id: job.id,
      state: job.state,
      session_id: job.session_id,
      pr_url: job.pr_url,
      detail: job.detail,
      updated_at: job.updated_at,
    })
  })

  app.post('/v1/runner/jobs/:id/status', async (c) => {
    await requireRunner(c)
    const body: unknown = await c.req.json().catch(() => {
      throw badRequest('invalid_json')
    })
    const parsed = statusUpdateSchema.safeParse(body)
    if (!parsed.success) {
      throw unprocessable(
        'invalid_status',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      )
    }
    const updated = await updateJob(c.env.DB, c.req.param('id'), parsed.data)
    if (!updated) throw notFound('unknown_job')
    return c.json({ id: updated.id, state: updated.state })
  })

  // Signed URL (`exp`, `sig`) or the runner bearer.
  app.get('/v1/runner/jobs/:id/screenshot', async (c) => {
    const id = c.req.param('id')
    const signed = await verifyScreenshotSignature(c.env.RUNNER_TOKEN, id, c.req.query('exp'), c.req.query('sig'))
    if (!signed && !(await isRunner(c))) throw unauthorized('bad or expired signature')

    const job = await getJob(c.env.DB, id)
    if (!job?.screenshot_key) throw notFound('no_screenshot')
    const object = await c.env.SCREENSHOTS.get(job.screenshot_key)
    if (!object) throw notFound('no_screenshot')

    return new Response(object.body, {
      headers: {
        'content-type': object.httpMetadata?.contentType ?? mimeForKey(job.screenshot_key),
        'content-length': String(object.size),
        'cache-control': 'private, no-store',
      },
    })
  })

  return app
}
