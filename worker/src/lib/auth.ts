import type { Context } from 'hono'

import { sha256Hex, timingSafeEqualStr } from './crypto'
import type { Bindings, Project } from './env'
import { unauthorized } from './errors'

type Ctx = Context<{ Bindings: Bindings }>

export function bearerToken(c: Ctx): string | null {
  const header = c.req.header('authorization')
  if (!header) return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match?.[1] ?? null
}

/** Project key → sha256 hex → `projects.key_hash`. Throws 401. */
export async function requireProject(c: Ctx): Promise<Project> {
  const key = bearerToken(c)
  if (!key) throw unauthorized('missing bearer project key')
  const hash = await sha256Hex(key)
  const project = await c.env.DB.prepare('SELECT * FROM projects WHERE key_hash = ?1').bind(hash).first<Project>()
  if (!project) throw unauthorized('unknown project key')
  return project
}

export async function isRunner(c: Ctx): Promise<boolean> {
  const token = bearerToken(c)
  if (!token || !c.env.RUNNER_TOKEN) return false
  return timingSafeEqualStr(token, c.env.RUNNER_TOKEN)
}

/** `Authorization: Bearer <runner_token>`. Throws 401. */
export async function requireRunner(c: Ctx): Promise<void> {
  if (!(await isRunner(c))) throw unauthorized()
}

/** `?token=<hook_token>`. Throws 401. */
export async function requireHookToken(c: Ctx): Promise<void> {
  const token = c.req.query('token')
  if (!token || !c.env.HOOK_TOKEN || !(await timingSafeEqualStr(token, c.env.HOOK_TOKEN))) {
    throw unauthorized()
  }
}
