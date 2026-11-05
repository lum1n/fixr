import type { ContentfulStatusCode } from 'hono/utils/http-status'

/** An error that becomes `{"error": code, "detail"?}` with `status`. */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode
  readonly code: string
  readonly detail: unknown

  constructor(status: ContentfulStatusCode, code: string, detail?: unknown) {
    super(code)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export const badRequest = (code: string, detail?: unknown) => new HttpError(400, code, detail)
export const unauthorized = (detail?: unknown) => new HttpError(401, 'unauthorized', detail)
export const notFound = (code = 'not_found') => new HttpError(404, code)
export const tooLarge = (code: string, detail?: unknown) => new HttpError(413, code, detail)
export const unprocessable = (code: string, detail?: unknown) => new HttpError(422, code, detail)

export function toErrorResponse(error: unknown): {
  status: ContentfulStatusCode
  body: { error: string; detail?: unknown }
} {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: error.detail === undefined ? { error: error.code } : { error: error.code, detail: error.detail },
    }
  }
  console.error(error)
  return { status: 500, body: { error: 'internal_error' } }
}
