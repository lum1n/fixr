import type { JobRow, JobState } from './env'
import { isoSeconds } from './time'

export const STALE_CLAIM_MS = 10 * 60 * 1000

/**
 * Claims the oldest queued job in one statement. The outer `state = 'queued'`
 * guard makes a lost race return no row instead of claiming twice.
 */
export function claimNextJob(db: D1Database, nowMs = Date.now()): Promise<JobRow | null> {
  const now = isoSeconds(nowMs)
  return db
    .prepare(
      `UPDATE jobs SET state = 'claimed', claimed_at = ?1, updated_at = ?1
       WHERE id = (SELECT id FROM jobs WHERE state = 'queued' ORDER BY created_at, rowid LIMIT 1)
         AND state = 'queued'
       RETURNING *`,
    )
    .bind(now)
    .first<JobRow>()
}

/** Cron: `claimed` for more than 10 minutes without moving on → back to `queued`. */
export async function requeueStaleClaims(db: D1Database, nowMs = Date.now()): Promise<number> {
  const cutoff = isoSeconds(nowMs - STALE_CLAIM_MS)
  const result = await db
    .prepare(
      `UPDATE jobs SET state = 'queued', claimed_at = NULL, updated_at = ?2
       WHERE state = 'claimed' AND claimed_at < ?1`,
    )
    .bind(cutoff, isoSeconds(nowMs))
    .run()
  return result.meta.changes
}

export function getJob(db: D1Database, id: string): Promise<JobRow | null> {
  return db.prepare('SELECT * FROM jobs WHERE id = ?1').bind(id).first<JobRow>()
}

export type JobPatch = {
  state: JobState
  session_id?: string | undefined
  pr_url?: string | undefined
  detail?: string | undefined
}

/** Sets `state`; members left undefined keep their stored value. */
export function updateJob(db: D1Database, id: string, patch: JobPatch, nowMs = Date.now()) {
  return db
    .prepare(
      `UPDATE jobs SET
         state = ?2,
         session_id = COALESCE(?3, session_id),
         pr_url = COALESCE(?4, pr_url),
         detail = COALESCE(?5, detail),
         claimed_at = CASE WHEN ?2 = 'claimed' THEN ?6 ELSE claimed_at END,
         updated_at = ?6
       WHERE id = ?1
       RETURNING id, state`,
    )
    .bind(id, patch.state, patch.session_id ?? null, patch.pr_url ?? null, patch.detail ?? null, isoSeconds(nowMs))
    .first<{ id: string; state: JobState }>()
}
