import { badRequest, tooLarge } from './errors'

/** Reads the whole body, failing with 413 as soon as it passes `limit` bytes. */
export async function readBodyLimited(req: Request, limit: number): Promise<Uint8Array> {
  const declared = req.headers.get('content-length')
  if (declared !== null && Number(declared) > limit) {
    throw tooLarge('body_too_large', { limit })
  }
  if (!req.body) return new Uint8Array()

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw tooLarge('body_too_large', { limit })
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export type Part = {
  name: string
  filename: string | undefined
  contentType: string | undefined
  data: Uint8Array
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0]
  if (first === undefined) return from
  const last = haystack.length - needle.length
  for (let i = haystack.indexOf(first, from); i !== -1 && i <= last; i = haystack.indexOf(first, i + 1)) {
    let j = 1
    while (j < needle.length && haystack[i + j] === needle[j]) j++
    if (j === needle.length) return i
  }
  return -1
}

export function multipartBoundary(contentType: string): string | null {
  const match = /;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType)
  return match?.[1] ?? match?.[2] ?? null
}

function headerParam(value: string, param: string): string | undefined {
  const match = new RegExp(`;\\s*${param}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\s;]+))`, 'i').exec(value)
  const raw = match?.[1] ?? match?.[2]
  return raw?.replace(/\\(.)/g, '$1')
}

/**
 * A small RFC 7578 parser that keeps every part as bytes, so a binary part
 * without a filename is not decoded as text. Throws 400 on malformed input.
 */
export function parseMultipart(body: Uint8Array, boundary: string): Part[] {
  const delimiter = encoder.encode(`--${boundary}`)
  const nextDelimiter = encoder.encode(`\r\n--${boundary}`)
  const headerEnd = encoder.encode('\r\n\r\n')
  const malformed = (why: string) => badRequest('malformed_multipart', why)

  // The first delimiter is at the start or after a (ignored) preamble line.
  let pos = indexOf(body, delimiter, 0) === 0 ? 0 : indexOf(body, nextDelimiter, 0) + 2
  if (pos < 0 || pos === 1) throw malformed('no opening boundary')
  pos += delimiter.length

  const parts: Part[] = []
  for (;;) {
    if (body[pos] === 45 && body[pos + 1] === 45) return parts // closing `--`
    // Transport padding, then CRLF.
    while (body[pos] === 32 || body[pos] === 9) pos++
    if (body[pos] !== 13 || body[pos + 1] !== 10) throw malformed('expected CRLF after boundary')
    pos += 2

    const hEnd = indexOf(body, headerEnd, pos)
    if (hEnd === -1) throw malformed('unterminated part headers')
    const headers = new Map<string, string>()
    for (const line of decoder.decode(body.subarray(pos, hEnd)).split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon <= 0) throw malformed('bad header line')
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
    }
    const dataStart = hEnd + 4
    const dataEnd = indexOf(body, nextDelimiter, dataStart)
    if (dataEnd === -1) throw malformed('missing closing boundary')

    const disposition = headers.get('content-disposition')
    if (!disposition || !/^form-data\b/i.test(disposition)) throw malformed('part without form-data disposition')
    const name = headerParam(disposition, 'name')
    if (name === undefined) throw malformed('part without name')

    parts.push({
      name,
      filename: headerParam(disposition, 'filename'),
      contentType: headers.get('content-type')?.split(';')[0]?.trim().toLowerCase(),
      data: body.subarray(dataStart, dataEnd),
    })
    pos = dataEnd + nextDelimiter.length
  }
}
