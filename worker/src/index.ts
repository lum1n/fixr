import { Hono } from 'hono'
import { cors } from 'hono/cors'

import type { Bindings } from './lib/env'
import { toErrorResponse } from './lib/errors'
import { requeueStaleClaims } from './lib/jobs'
import { createHookRoutes } from './routes/hooks'
import { createReportRoutes } from './routes/reports'
import { createRunnerRoutes } from './routes/runner'

const app = new Hono<{ Bindings: Bindings }>()

// Browsers (the web SDK) post reports cross-origin. The project key travels
// in Authorization, not cookies, so any origin may send.
app.use(
  '/v1/reports',
  cors({
    origin: '*',
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Fixr-SDK'],
    exposeHeaders: ['Retry-After'],
    maxAge: 86400,
  }),
)
app.route('/', createReportRoutes())
app.route('/', createRunnerRoutes())
app.route('/', createHookRoutes())

app.notFound((c) => c.json({ error: 'not_found' }, 404))

app.onError((error, c) => {
  const { status, body } = toErrorResponse(error)
  return c.json(body, status)
})

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      requeueStaleClaims(env.DB).then((n) => {
        if (n > 0) console.log(`requeued ${n} stale claimed job(s)`)
      }),
    )
  },
} satisfies ExportedHandler<Bindings>
