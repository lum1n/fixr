import { z } from 'zod'

/**
 * Mirrors spec/report.schema.json (schema 1). Objects are strict (unknown
 * members rejected), optional members may be omitted but never `null`, and
 * string lengths count Unicode scalar values like JSON Schema does.
 */

const length = (s: string) => {
  let n = 0
  for (const _ of s) n++
  return n
}

/** A string of `min`–`max` Unicode scalar values. */
export const str = (min: number, max: number) =>
  z.string().refine((s) => {
    const n = length(s)
    return n >= min && n <= max
  }, `must be ${min === 0 ? `at most ${max}` : `${min}–${max}`} characters`)

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

export const PLATFORMS = ['ios', 'macos', 'web', 'linux', 'windows'] as const

export const sdkSchema = z.strictObject({
  name: str(1, 64),
  version: str(1, 32),
})

export const appSchema = z.strictObject({
  id: str(1, 200),
  version: str(0, 64).optional(),
  build: str(0, 64).optional(),
})

export const screenSchema = z.strictObject({
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  scale: z.number().gt(0),
})

export const deviceSchema = z.strictObject({
  platform: z.enum(PLATFORMS),
  os_version: str(0, 200).optional(),
  model: str(0, 200).optional(),
  screen: screenSchema.optional(),
})

export const contextSchema = z.strictObject({
  screen: str(0, 500).optional(),
  title: str(0, 500).optional(),
  url: str(0, 2000).optional(),
})

export const extraSchema = z
  .record(str(0, 64), str(0, 1000))
  .refine((m) => Object.keys(m).length <= 32, 'at most 32 keys')

export const reportShape = {
  schema: z.literal(1),
  id: z.string().regex(UUID_V4, 'must be a lowercase UUID v4'),
  created_at: z.string().regex(CREATED_AT, 'must be YYYY-MM-DDTHH:MM:SSZ'),
  prompt: str(1, 4000),
  sdk: sdkSchema,
  app: appSchema,
  device: deviceSchema,
  locale: str(0, 64).optional(),
  context: contextSchema.optional(),
  screenshot_omitted_reason: str(0, 64).optional(),
  extra: extraSchema.optional(),
}

/** The `report` part of a multipart body. */
export const reportSchema = z.strictObject(reportShape)

export type Report = z.infer<typeof reportSchema>

export const screenshotMimeSchema = z.enum(['image/png', 'image/jpeg'])

/** The application/json body: the report plus an inline screenshot. */
export const jsonReportBodySchema = z.strictObject({
  ...reportShape,
  screenshot: z
    .strictObject({
      mime: screenshotMimeSchema,
      data: z.base64(),
    })
    .optional(),
})

export type JsonReportBody = z.infer<typeof jsonReportBodySchema>
