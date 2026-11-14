import { describe, expect, it } from 'vitest'

import { multipartBoundary, parseMultipart, readBodyLimited } from '../src/lib/body'
import { HttpError } from '../src/lib/errors'
import { imageSize, isImageMime, mimeForKey } from '../src/lib/image'
import { jpeg, multipart, png } from './helpers'

const enc = new TextEncoder()
const text = (b: Uint8Array) => new TextDecoder().decode(b)

function expectHttpError(fn: () => unknown, status: number, code: string) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError)
    expect((e as HttpError).status).toBe(status)
    expect((e as HttpError).code).toBe(code)
    return
  }
  throw new Error('expected HttpError')
}

describe('image helpers', () => {
  it('recognises only png and jpeg mimes', () => {
    expect(isImageMime('image/png')).toBe(true)
    expect(isImageMime('image/jpeg')).toBe(true)
    expect(isImageMime('image/gif')).toBe(false)
    expect(isImageMime(undefined)).toBe(false)
  })

  it('maps storage keys to mimes', () => {
    expect(mimeForKey('jobs/a.png')).toBe('image/png')
    expect(mimeForKey('jobs/a.jpg')).toBe('image/jpeg')
  })

  it('reads png dimensions', () => {
    expect(imageSize('image/png', png(1512, 982))).toEqual({ width: 1512, height: 982 })
  })

  it('rejects png with a bad signature, truncation, or non-IHDR first chunk', () => {
    const bad = png()
    bad[0] = 0
    expect(imageSize('image/png', bad)).toBeNull()
    expect(imageSize('image/png', png().subarray(0, 23))).toBeNull()
    const notIhdr = png()
    notIhdr[12] = 0x58
    expect(imageSize('image/png', notIhdr)).toBeNull()
  })

  it('reads jpeg dimensions past an APP segment', () => {
    expect(imageSize('image/jpeg', jpeg(800, 600))).toEqual({ width: 800, height: 600 })
  })

  it('rejects non-jpeg bytes, and jpeg without a SOF before SOS/EOI', () => {
    expect(imageSize('image/jpeg', png())).toBeNull()
    expect(imageSize('image/jpeg', new Uint8Array([0xff, 0xd8]))).toBeNull()
    expect(imageSize('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull()
    expect(imageSize('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x00]))).toBeNull()
  })

  it('skips DHT (0xc4) markers rather than treating them as SOF', () => {
    const bytes = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc4, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc2, 0x00, 0x11, 0x08, 0x00, 0x0a, 0x00, 0x14, 0x03,
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ])
    expect(imageSize('image/jpeg', bytes)).toEqual({ width: 20, height: 10 })
  })

  it('does not loop on a zero-length segment', () => {
    expect(imageSize('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00]))).toBeNull()
  })
})

describe('readBodyLimited', () => {
  const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request('https://fixr.test/', { method: 'POST', body, headers })

  it('returns the whole body when within the limit', async () => {
    expect(text(await readBodyLimited(req('hello'), 5))).toBe('hello')
  })

  it('returns an empty array for no body', async () => {
    expect((await readBodyLimited(new Request('https://fixr.test/'), 10)).byteLength).toBe(0)
  })

  it('rejects early on a declared content-length over the limit', async () => {
    await expect(readBodyLimited(req('x', { 'content-length': '100' }), 10)).rejects.toMatchObject({
      status: 413,
      code: 'body_too_large',
      detail: { limit: 10 },
    })
  })

  it('rejects a streamed body that exceeds the limit with no content-length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('12345'))
        c.enqueue(enc.encode('678'))
        c.close()
      },
    })
    const r = new Request('https://fixr.test/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    await expect(readBodyLimited(r, 6)).rejects.toMatchObject({ status: 413 })
  })

  it('concatenates multiple chunks in order', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('ab'))
        c.enqueue(enc.encode('cd'))
        c.close()
      },
    })
    const r = new Request('https://fixr.test/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    expect(text(await readBodyLimited(r, 4))).toBe('abcd')
  })
})

describe('multipartBoundary', () => {
  it('reads bare and quoted boundaries', () => {
    expect(multipartBoundary('multipart/form-data; boundary=abc123')).toBe('abc123')
    expect(multipartBoundary('multipart/form-data; boundary="a b;c"')).toBe('a b;c')
    expect(multipartBoundary('Multipart/Form-Data; Boundary=xyz; charset=utf-8')).toBe('xyz')
  })

  it('returns null without a boundary', () => {
    expect(multipartBoundary('multipart/form-data')).toBeNull()
  })
})

describe('parseMultipart', () => {
  const boundary = 'fixr-boundary-1234'

  it('keeps binary part bytes intact, including CRLF and boundary-like sequences', () => {
    const data = new Uint8Array([0, 255, 13, 10, 45, 45, 1, 13, 10, 128])
    const { body } = multipart([
      { name: 'report', contentType: 'application/json; charset=utf-8', data: '{"a":1}' },
      { name: 'screenshot', filename: 'a.png', contentType: 'IMAGE/PNG', data },
    ])
    const parts = parseMultipart(body, boundary)
    expect(parts.map((p) => p.name)).toEqual(['report', 'screenshot'])
    expect(parts[0]!.contentType).toBe('application/json')
    expect(parts[0]!.filename).toBeUndefined()
    expect(text(parts[0]!.data)).toBe('{"a":1}')
    expect(parts[1]!.filename).toBe('a.png')
    expect(parts[1]!.contentType).toBe('image/png')
    expect([...parts[1]!.data]).toEqual([...data])
  })

  it('returns no parts for an immediately closed body', () => {
    expect(parseMultipart(enc.encode(`--${boundary}--\r\n`), boundary)).toEqual([])
  })

  it('ignores a preamble before the first boundary', () => {
    const body = enc.encode(
      `preamble\r\n--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\nv\r\n--${boundary}--\r\n`,
    )
    expect(parseMultipart(body, boundary).map((p) => text(p.data))).toEqual(['v'])
  })

  it('unescapes quoted parameter values', () => {
    const body = enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="a\\"b"; filename="c.png"\r\n\r\nv\r\n--${boundary}--`,
    )
    const [part] = parseMultipart(body, boundary)
    expect(part!.name).toBe('a"b')
    expect(part!.filename).toBe('c.png')
  })

  it('throws 400 for malformed bodies', () => {
    const bad = (s: string) => () => parseMultipart(enc.encode(s), boundary)
    expectHttpError(bad('no boundary here'), 400, 'malformed_multipart')
    expectHttpError(bad(`--${boundary}X\r\n`), 400, 'malformed_multipart')
    expectHttpError(bad(`--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n`), 400, 'malformed_multipart')
    expectHttpError(bad(`--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\nv`), 400, 'malformed_multipart')
    expectHttpError(bad(`--${boundary}\r\nnocolon\r\n\r\nv\r\n--${boundary}--`), 400, 'malformed_multipart')
    expectHttpError(bad(`--${boundary}\r\nContent-Type: text/plain\r\n\r\nv\r\n--${boundary}--`), 400, 'malformed_multipart')
    expectHttpError(bad(`--${boundary}\r\nContent-Disposition: form-data\r\n\r\nv\r\n--${boundary}--`), 400, 'malformed_multipart')
  })
})
