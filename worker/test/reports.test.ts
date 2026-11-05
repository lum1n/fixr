import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

import fixture from '../../spec/fixtures/report.v1.json'
import { reportSchema } from '../src/schema/report'
import {
  base64,
  call,
  jpeg,
  newId,
  png,
  postJson,
  postMultipart,
  PROJECT_KEY,
  report,
  seedProject,
} from './helpers'

beforeEach(async () => {
  await seedProject()
})

describe('auth', () => {
  it('rejects a missing key with 401', async () => {
    const res = await call('/v1/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report()),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized' })
  })

  it('rejects an unknown key with 401', async () => {
    const res = await call('/v1/reports', {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: JSON.stringify(report()),
    })
    expect(res.status).toBe(401)
  })
})

describe('schema', () => {
  it('accepts the golden fixture unchanged', () => {
    const parsed = reportSchema.safeParse(fixture)
    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual(fixture)
  })

  it('counts prompt length in Unicode scalar values', () => {
    expect(reportSchema.safeParse(report({ prompt: '😀'.repeat(4000) })).success).toBe(true)
    expect(reportSchema.safeParse(report({ prompt: '😀'.repeat(4001) })).success).toBe(false)
    expect(reportSchema.safeParse(report({ prompt: '' })).success).toBe(false)
  })

  it('rejects null optionals, unknown nested members and bad enums', () => {
    expect(reportSchema.safeParse(report({ locale: null })).success).toBe(false)
    expect(reportSchema.safeParse(report({ device: { platform: 'android' } })).success).toBe(false)
    expect(reportSchema.safeParse(report({ app: { id: 'x', extra: 'y' } })).success).toBe(false)
    expect(reportSchema.safeParse(report({ id: newId().toUpperCase() })).success).toBe(false)
    expect(reportSchema.safeParse(report({ created_at: '2026-11-05T14:03:12.000Z' })).success).toBe(false)
    const extra = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']))
    expect(reportSchema.safeParse(report({ extra })).success).toBe(false)
    expect(reportSchema.safeParse(report({ extra: { ['k'.repeat(65)]: 'v' } })).success).toBe(false)
    expect(reportSchema.safeParse(report({ extra: { k: 1 } })).success).toBe(false)
  })
})

describe('POST /v1/reports multipart', () => {
  it('accepts the golden fixture without a screenshot', async () => {
    const res = await postMultipart(fixture, undefined, { 'idempotency-key': fixture.id })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: fixture.id })

    const row = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?1').bind(fixture.id).first<Record<string, unknown>>()
    expect(row).toMatchObject({ project_id: 'notes', state: 'queued', screenshot_key: null })
    expect(JSON.parse(row!.report_json as string)).toEqual(fixture)
  })

  it('parses the screenshot part and writes it to R2', async () => {
    const id = newId()
    const image = png(1512, 982, 4096)
    const res = await postMultipart(
      report({ id }),
      { name: 'screenshot', filename: 'screenshot.png', contentType: 'image/png', data: image },
      { 'idempotency-key': id },
    )
    expect(res.status).toBe(201)

    const object = await env.SCREENSHOTS.get(`jobs/${id}.png`)
    expect(object).not.toBeNull()
    expect(object!.httpMetadata?.contentType).toBe('image/png')
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(image)

    const row = await env.DB.prepare('SELECT screenshot_key FROM jobs WHERE id = ?1').bind(id).first()
    expect(row).toEqual({ screenshot_key: `jobs/${id}.png` })
  })

  it('rejects an unknown member with 422', async () => {
    const res = await postMultipart(report({ id: newId(), surprise: true }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: 'invalid_report' })
  })

  it('rejects unexpected parts and non-JSON reports with 400', async () => {
    const extra = await postMultipart(report({ id: newId() }), { name: 'other', data: 'x' })
    expect(extra.status).toBe(400)
    const bad = await call('/v1/reports', {
      method: 'POST',
      headers: { authorization: `Bearer ${PROJECT_KEY}`, 'content-type': 'multipart/form-data; boundary=b' },
      body: '--b\r\nContent-Disposition: form-data; name="report"\r\n\r\n{nope\r\n--b--\r\n',
    })
    expect(bad.status).toBe(400)
  })

  it('rejects a screenshot that is not png/jpeg with 422', async () => {
    const gif = await postMultipart(report({ id: newId() }), {
      name: 'screenshot',
      filename: 'x.gif',
      contentType: 'image/gif',
      data: new Uint8Array([0x47, 0x49, 0x46]),
    })
    expect(gif.status).toBe(422)
    const lying = await postMultipart(report({ id: newId() }), {
      name: 'screenshot',
      filename: 'screenshot.png',
      contentType: 'image/png',
      data: jpeg(),
    })
    expect(lying.status).toBe(422)
  })

  it('rejects a screenshot with a long edge over 2000 px with 422', async () => {
    const res = await postMultipart(report({ id: newId() }), {
      name: 'screenshot',
      filename: 'screenshot.png',
      contentType: 'image/png',
      data: png(2001, 100),
    })
    expect(res.status).toBe(422)
  })
})

describe('POST /v1/reports application/json', () => {
  it('accepts an inline base64 screenshot', async () => {
    const id = newId()
    const image = jpeg(800, 600)
    const res = await postJson(report({ id, screenshot: { mime: 'image/jpeg', data: base64(image) } }), {
      'idempotency-key': id,
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id })

    const object = await env.SCREENSHOTS.get(`jobs/${id}.jpg`)
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(image)
    const row = await env.DB.prepare('SELECT report_json FROM jobs WHERE id = ?1').bind(id).first<{ report_json: string }>()
    expect(JSON.parse(row!.report_json)).not.toHaveProperty('screenshot')
  })

  it('rejects bad base64 and unknown screenshot members with 422', async () => {
    expect((await postJson(report({ id: newId(), screenshot: { mime: 'image/png', data: '***' } }))).status).toBe(422)
    expect(
      (await postJson(report({ id: newId(), screenshot: { mime: 'image/png', data: base64(png()), name: 'x' } }))).status,
    ).toBe(422)
  })

  it('rejects invalid JSON with 400 and other content types with 400', async () => {
    const bad = await call('/v1/reports', {
      method: 'POST',
      headers: { authorization: `Bearer ${PROJECT_KEY}`, 'content-type': 'application/json' },
      body: '{',
    })
    expect(bad.status).toBe(400)
    const text = await call('/v1/reports', {
      method: 'POST',
      headers: { authorization: `Bearer ${PROJECT_KEY}`, 'content-type': 'text/plain' },
      body: 'hi',
    })
    expect(text.status).toBe(400)
  })
})

describe('limits', () => {
  it('rejects a declared Content-Length over 2.5 MiB with 413', async () => {
    const res = await call('/v1/reports', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${PROJECT_KEY}`,
        'content-type': 'application/json',
        'content-length': String(2_621_441),
      },
      body: new Uint8Array(2_621_441),
    })
    expect(res.status).toBe(413)
  })

  it('rejects a streamed body over 2.5 MiB with 413', async () => {
    const chunk = new Uint8Array(256 * 1024)
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 11) return controller.close()
        sent++
        controller.enqueue(chunk)
      },
    })
    const res = await call('/v1/reports', {
      method: 'POST',
      headers: { authorization: `Bearer ${PROJECT_KEY}`, 'content-type': 'application/json' },
      body: stream,
    })
    expect(res.status).toBe(413)
  })

  it('rejects an image over 2 MB with 413', async () => {
    const res = await postMultipart(report({ id: newId() }), {
      name: 'screenshot',
      filename: 'screenshot.png',
      contentType: 'image/png',
      data: png(1000, 1000, 2_000_001),
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ error: 'screenshot_too_large' })
  })

  it('accepts an image of exactly 2 MB', async () => {
    const res = await postMultipart(report({ id: newId() }), {
      name: 'screenshot',
      filename: 'screenshot.png',
      contentType: 'image/png',
      data: png(1000, 1000, 2_000_000),
    })
    expect(res.status).toBe(201)
  })
})

describe('idempotency', () => {
  it('answers a duplicate id with 200 and keeps one job', async () => {
    const id = newId()
    const doc = report({ id })
    expect((await postMultipart(doc, undefined, { 'idempotency-key': id })).status).toBe(201)
    const again = await postMultipart(doc, undefined, { 'idempotency-key': id })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ id, duplicate: true })
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs WHERE id = ?1').bind(id).first<{ n: number }>()
    expect(count!.n).toBe(1)
  })

  it('rejects an Idempotency-Key that differs from report.id with 400', async () => {
    const res = await postMultipart(report({ id: newId() }), undefined, { 'idempotency-key': newId() })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'idempotency_key_mismatch' })
  })
})
