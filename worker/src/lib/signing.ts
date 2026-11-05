import { hmacSha256Hex, timingSafeEqualStr } from './crypto'

export const SCREENSHOT_URL_TTL_SECONDS = 15 * 60

/** HMAC-SHA256 of `<id>.<exp>` keyed by the runner token, lowercase hex. */
export function signScreenshot(secret: string, id: string, exp: number): Promise<string> {
  return hmacSha256Hex(secret, `${id}.${exp}`)
}

export async function screenshotUrl(origin: string, secret: string, id: string, nowMs = Date.now()): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + SCREENSHOT_URL_TTL_SECONDS
  const sig = await signScreenshot(secret, id, exp)
  return `${origin}/v1/runner/jobs/${encodeURIComponent(id)}/screenshot?exp=${exp}&sig=${sig}`
}

export async function verifyScreenshotSignature(
  secret: string,
  id: string,
  exp: string | undefined,
  sig: string | undefined,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!secret || !exp || !sig || !/^\d{1,12}$/.test(exp)) return false
  if (Number(exp) < Math.floor(nowMs / 1000)) return false
  const expected = await signScreenshot(secret, id, Number(exp))
  return timingSafeEqualStr(sig.toLowerCase(), expected)
}
