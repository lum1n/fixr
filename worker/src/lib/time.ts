/** UTC, whole seconds: `YYYY-MM-DDTHH:MM:SSZ`. */
export function isoSeconds(ms: number = Date.now()): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
