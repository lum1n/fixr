import { env, exports } from 'cloudflare:workers'

import fixture from '../../spec/fixtures/report.v1.json'
import { sha256Hex } from '../src/lib/crypto'

export const ORIGIN = 'https://fixr.test'
export const PROJECT_KEY = 'fixr_pk_test_key'
export const RUNNER = { authorization: 'Bearer test-runner-token' }
export const HOOK_TOKEN = 'test-hook-token'

export type ReportDoc = typeof fixture & Record<string, unknown>

/** A fresh copy of the golden fixture, optionally with a new id. */
export function report(overrides: Record<string, unknown> = {}): ReportDoc {
  return { ...structuredClone(fixture), ...overrides } as ReportDoc
}

export function newId(): string {
  return crypto.randomUUID()
}

export async function seedProject(id = 'notes', key = PROJECT_KEY, model: string | null = 'opus') {
  await env.DB.prepare(
    `INSERT INTO projects (id, key_hash, repo_path, base_branch, harness, permission, model, created_at)
     VALUES (?1, ?2, '~/repos/notes', 'main', 'claude', 'bypassPermissions', ?3, '2026-11-05T00:00:00Z')`,
  )
    .bind(id, await sha256Hex(key), model)
    .run()
}

export function call(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init))
}

/** A PNG header with an IHDR of `width`×`height`, padded to `size` bytes. */
export function png(width = 100, height = 80, size = 64): Uint8Array {
  const out = new Uint8Array(Math.max(size, 33))
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(out.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  out.set([8, 6, 0, 0, 0], 24)
  return out
}

/** SOI, an APP0 segment, then SOF0 with `width`×`height`. */
export function jpeg(width = 100, height = 80): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ])
}

const encoder = new TextEncoder()

export type MultipartPart = {
  name: string
  filename?: string
  contentType?: string
  data: string | Uint8Array
}

export function multipart(parts: MultipartPart[], boundary = 'fixr-boundary-1234'): { body: Uint8Array; contentType: string } {
  const chunks: Uint8Array[] = []
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`
    if (p.filename) head += `; filename="${p.filename}"`
    head += '\r\n'
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`
    head += '\r\n'
    chunks.push(encoder.encode(head), typeof p.data === 'string' ? encoder.encode(p.data) : p.data, encoder.encode('\r\n'))
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`))
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const body = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    body.set(c, offset)
    offset += c.byteLength
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

export function postMultipart(doc: unknown, screenshot?: MultipartPart, headers: Record<string, string> = {}) {
  const parts: MultipartPart[] = [{ name: 'report', contentType: 'application/json', data: JSON.stringify(doc) }]
  if (screenshot) parts.push(screenshot)
  const { body, contentType } = multipart(parts)
  return call('/v1/reports', {
    method: 'POST',
    headers: { authorization: `Bearer ${PROJECT_KEY}`, 'content-type': contentType, ...headers },
    body,
  })
}

export function postJson(doc: unknown, headers: Record<string, string> = {}) {
  return call('/v1/reports', {
    method: 'POST',
    headers: { authorization: `Bearer ${PROJECT_KEY}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(doc),
  })
}

export function base64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export async function insertJob(
  id: string,
  fields: { state?: string; session_id?: string | null; claimed_at?: string | null; created_at?: string } = {},
) {
  await env.DB.prepare(
    `INSERT INTO jobs (id, project_id, report_json, screenshot_key, state, session_id, claimed_at, created_at, updated_at)
     VALUES (?1, 'notes', ?2, NULL, ?3, ?4, ?5, ?6, ?6)`,
  )
    .bind(
      id,
      JSON.stringify(report({ id })),
      fields.state ?? 'queued',
      fields.session_id ?? null,
      fields.claimed_at ?? null,
      fields.created_at ?? '2026-11-05T14:00:00Z',
    )
    .run()
}
