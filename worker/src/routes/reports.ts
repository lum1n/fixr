import { Hono } from 'hono'
import type { z } from 'zod'

import { requireProject } from '../lib/auth'
import { multipartBoundary, parseMultipart, readBodyLimited } from '../lib/body'
import type { Bindings } from '../lib/env'
import { badRequest, tooLarge, unprocessable } from '../lib/errors'
import { IMAGE_EXTENSIONS, type ImageMime, imageSize, isImageMime } from '../lib/image'
import { isoSeconds } from '../lib/time'
import { jsonReportBodySchema, type Report, reportSchema } from '../schema/report'

export const MAX_BODY_BYTES = 2_621_440 // 2.5 MiB
export const MAX_IMAGE_BYTES = 2_000_000
export const MAX_IMAGE_EDGE = 2000

type Screenshot = { mime: ImageMime; bytes: Uint8Array }

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

function parseJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes))
  } catch {
    throw badRequest('invalid_json', `${what} is not valid UTF-8 JSON`)
  }
}

function issues(error: z.ZodError) {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
}

function decodeBase64(data: string): Uint8Array {
  const bin = atob(data)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function fromMultipart(body: Uint8Array, contentType: string): { report: Report; screenshot: Screenshot | null } {
  const boundary = multipartBoundary(contentType)
  if (!boundary) throw badRequest('malformed_multipart', 'missing boundary')
  const parts = parseMultipart(body, boundary)

  const names = parts.map((p) => p.name)
  const unknown = names.filter((n) => n !== 'report' && n !== 'screenshot')
  if (unknown.length > 0) throw badRequest('unexpected_part', { parts: unknown })
  if (names.filter((n) => n === 'report').length !== 1 || names.filter((n) => n === 'screenshot').length > 1) {
    throw badRequest('bad_parts', 'expected one `report` part and at most one `screenshot` part')
  }

  const reportPart = parts.find((p) => p.name === 'report')!
  const parsed = reportSchema.safeParse(parseJson(reportPart.data, 'report part'))
  if (!parsed.success) throw unprocessable('invalid_report', issues(parsed.error))

  const shotPart = parts.find((p) => p.name === 'screenshot')
  if (!shotPart) return { report: parsed.data, screenshot: null }
  if (!isImageMime(shotPart.contentType)) {
    throw unprocessable('unsupported_screenshot_type', 'screenshot must be image/png or image/jpeg')
  }
  return { report: parsed.data, screenshot: { mime: shotPart.contentType, bytes: shotPart.data } }
}

function fromJson(body: Uint8Array): { report: Report; screenshot: Screenshot | null } {
  const parsed = jsonReportBodySchema.safeParse(parseJson(body, 'body'))
  if (!parsed.success) throw unprocessable('invalid_report', issues(parsed.error))
  const { screenshot, ...report } = parsed.data
  if (!screenshot) return { report, screenshot: null }
  return { report, screenshot: { mime: screenshot.mime, bytes: decodeBase64(screenshot.data) } }
}

function checkScreenshot(shot: Screenshot) {
  if (shot.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw tooLarge('screenshot_too_large', { limit: MAX_IMAGE_BYTES })
  }
  const size = imageSize(shot.mime, shot.bytes)
  if (!size) throw unprocessable('invalid_screenshot', `bytes are not a valid ${shot.mime}`)
  if (Math.max(size.width, size.height) > MAX_IMAGE_EDGE) {
    throw unprocessable('screenshot_too_big', { limit: MAX_IMAGE_EDGE, width: size.width, height: size.height })
  }
}

export function createReportRoutes() {
  const app = new Hono<{ Bindings: Bindings }>()

  app.post('/v1/reports', async (c) => {
    const project = await requireProject(c)
    const body = await readBodyLimited(c.req.raw, MAX_BODY_BYTES)

    const contentType = (c.req.header('content-type') ?? '').toLowerCase()
    let parsed: { report: Report; screenshot: Screenshot | null }
    if (contentType.startsWith('multipart/form-data')) {
      parsed = fromMultipart(body, c.req.header('content-type') ?? '')
    } else if (contentType.startsWith('application/json')) {
      parsed = fromJson(body)
    } else {
      throw badRequest('unsupported_content_type', 'use multipart/form-data or application/json')
    }
    const { report, screenshot } = parsed

    const idempotencyKey = c.req.header('idempotency-key')
    if (idempotencyKey !== undefined && idempotencyKey !== report.id) {
      throw badRequest('idempotency_key_mismatch', 'Idempotency-Key must equal report.id')
    }
    if (screenshot) checkScreenshot(screenshot)

    const db = c.env.DB
    const existing = await db.prepare('SELECT id FROM jobs WHERE id = ?1').bind(report.id).first()
    if (existing) return c.json({ id: report.id, duplicate: true }, 200)

    // Screenshot first: a job row never points at a missing object.
    let screenshotKey: string | null = null
    if (screenshot) {
      screenshotKey = `jobs/${report.id}.${IMAGE_EXTENSIONS[screenshot.mime]}`
      await c.env.SCREENSHOTS.put(screenshotKey, screenshot.bytes, {
        httpMetadata: { contentType: screenshot.mime },
      })
    }

    const now = isoSeconds()
    const result = await db
      .prepare(
        `INSERT INTO jobs (id, project_id, report_json, screenshot_key, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?5)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(report.id, project.id, JSON.stringify(report), screenshotKey, now)
      .run()
    if (result.meta.changes === 0) return c.json({ id: report.id, duplicate: true }, 200)

    return c.json({ id: report.id }, 201)
  })

  return app
}
