import { z } from 'zod'

/**
 * acc `HostEvent` (acc-core/src/watch.rs). Loose on purpose: acc may add
 * members, and the Worker only reads the ones below.
 */
export const hostEventSchema = z.looseObject({
  at: z.number(),
  session: z.string().min(1),
  state: z.enum(['blocked', 'done', 'error', 'exited']),
  kind: z.string().optional(),
  detail: z.string().optional(),
  code: z.number().int().optional(),
  offset: z.number().optional(),
})

export type HostEvent = z.infer<typeof hostEventSchema>
