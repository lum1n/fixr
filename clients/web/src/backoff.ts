/** Delays (ms) after attempt n fails: 30 s, 2 min, 10 min, 1 h, 6 h, then every 24 h. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;
export const DAILY_MS = 86_400_000;
export const MAX_ATTEMPTS = 20;
export const MAX_AGE_MS = 7 * DAILY_MS;

/** Delay before the next attempt after `attempts` failed attempts (attempts ≥ 1). */
export function retryDelay(attempts: number, retryAfterMs?: number): number {
  const base = RETRY_DELAYS_MS[Math.max(1, attempts) - 1] ?? DAILY_MS;
  return retryAfterMs !== undefined && retryAfterMs > base ? retryAfterMs : base;
}

/** Dropped after 20 attempts or 7 days after created_at, whichever first. */
export function shouldGiveUp(attempts: number, createdAtMs: number, nowMs: number): boolean {
  return attempts >= MAX_ATTEMPTS || nowMs - createdAtMs >= MAX_AGE_MS;
}

/** Parse Retry-After: delta-seconds, or an HTTP date. Returns ms or undefined. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - nowMs);
}
