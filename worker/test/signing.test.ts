import { describe, expect, it } from 'vitest'

import { hmacSha256Hex, sha256Hex, timingSafeEqualStr, toHex } from '../src/lib/crypto'
import {
  SCREENSHOT_URL_TTL_SECONDS,
  screenshotUrl,
  signScreenshot,
  verifyScreenshotSignature,
} from '../src/lib/signing'
import { isoSeconds } from '../src/lib/time'

describe('crypto', () => {
  it('hex-encodes bytes with zero padding', () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff')
    expect(toHex(new Uint8Array([0xab]).buffer)).toBe('ab')
  })

  it('matches known SHA-256 and HMAC-SHA256 vectors', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(await hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    )
  })

  it('compares strings of differing lengths without throwing', async () => {
    expect(await timingSafeEqualStr('same', 'same')).toBe(true)
    expect(await timingSafeEqualStr('same', 'samee')).toBe(false)
    expect(await timingSafeEqualStr('', 'x')).toBe(false)
  })
})

describe('screenshot signing', () => {
  const secret = 'runner-secret'
  const now = Date.UTC(2026, 10, 5, 12, 0, 0)
  const nowSec = now / 1000

  it('builds a url that verifies', async () => {
    const url = new URL(await screenshotUrl('https://w.example', secret, 'job 1', now))
    expect(url.pathname).toBe('/v1/runner/jobs/job%201/screenshot')
    const exp = url.searchParams.get('exp')!
    expect(Number(exp)).toBe(nowSec + SCREENSHOT_URL_TTL_SECONDS)
    expect(await verifyScreenshotSignature(secret, 'job 1', exp, url.searchParams.get('sig')!, now)).toBe(true)
  })

  it('accepts uppercase hex and the exact expiry second, rejects after it', async () => {
    const exp = nowSec + 10
    const sig = await signScreenshot(secret, 'a', exp)
    expect(await verifyScreenshotSignature(secret, 'a', String(exp), sig.toUpperCase(), now)).toBe(true)
    expect(await verifyScreenshotSignature(secret, 'a', String(exp), sig, exp * 1000)).toBe(true)
    expect(await verifyScreenshotSignature(secret, 'a', String(exp), sig, (exp + 1) * 1000)).toBe(false)
  })

  it('rejects tampering and malformed input', async () => {
    const exp = nowSec + 60
    const sig = await signScreenshot(secret, 'a', exp)
    expect(await verifyScreenshotSignature(secret, 'b', String(exp), sig, now)).toBe(false)
    expect(await verifyScreenshotSignature(secret, 'a', String(exp + 1), sig, now)).toBe(false)
    expect(await verifyScreenshotSignature('other', 'a', String(exp), sig, now)).toBe(false)
    expect(await verifyScreenshotSignature('', 'a', String(exp), sig, now)).toBe(false)
    expect(await verifyScreenshotSignature(secret, 'a', undefined, sig, now)).toBe(false)
    expect(await verifyScreenshotSignature(secret, 'a', String(exp), undefined, now)).toBe(false)
    expect(await verifyScreenshotSignature(secret, 'a', '1e9', sig, now)).toBe(false)
    expect(await verifyScreenshotSignature(secret, 'a', '-5', sig, now)).toBe(false)
    expect(await verifyScreenshotSignature(secret, 'a', '1234567890123', sig, now)).toBe(false)
  })
})

describe('isoSeconds', () => {
  it('formats UTC whole seconds and truncates milliseconds', () => {
    expect(isoSeconds(Date.UTC(2026, 10, 5, 12, 0, 0, 999))).toBe('2026-11-05T12:00:00Z')
    expect(isoSeconds(0)).toBe('1970-01-01T00:00:00Z')
  })
})
