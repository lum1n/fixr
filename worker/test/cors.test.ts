import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('CORS on /v1/reports', () => {
  it('answers the preflight with the SDK headers allowed', async () => {
    const res = await SELF.fetch('https://fixr.test/v1/reports', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type, idempotency-key, x-fixr-sdk',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    for (const h of ['authorization', 'content-type', 'idempotency-key', 'x-fixr-sdk']) expect(allowed).toContain(h)
  })

  it('exposes Retry-After on responses', async () => {
    const res = await SELF.fetch('https://fixr.test/v1/reports', { method: 'POST', headers: { Origin: 'https://app.example.com' } })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect((res.headers.get('access-control-expose-headers') ?? '').toLowerCase()).toContain('retry-after')
  })

  it('does not open the runner API to browsers', async () => {
    const res = await SELF.fetch('https://fixr.test/v1/runner/next', { headers: { Origin: 'https://app.example.com' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})
