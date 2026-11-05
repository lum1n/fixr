import { z } from 'zod'

export const RUNNER_STATES = ['claimed', 'running', 'done', 'blocked', 'error'] as const

/** `POST /v1/runner/jobs/:id/status`. Omitted members leave the stored value unchanged. */
export const statusUpdateSchema = z.strictObject({
  state: z.enum(RUNNER_STATES),
  session_id: z.string().min(1).max(200).optional(),
  pr_url: z.string().min(1).max(2000).optional(),
  detail: z.string().max(4000).optional(),
})

export type StatusUpdate = z.infer<typeof statusUpdateSchema>

export const MAX_WAIT_SECONDS = 25
