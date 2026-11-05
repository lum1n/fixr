export type ImageMime = 'image/png' | 'image/jpeg'

export const IMAGE_EXTENSIONS: Record<ImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' }

export function isImageMime(value: string | undefined): value is ImageMime {
  return value === 'image/png' || value === 'image/jpeg'
}

export function mimeForKey(key: string): ImageMime {
  return key.endsWith('.png') ? 'image/png' : 'image/jpeg'
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Pixel size read from the PNG IHDR or the JPEG SOF segment; null if the bytes are not that format. */
export function imageSize(mime: ImageMime, bytes: Uint8Array): { width: number; height: number } | null {
  return mime === 'image/png' ? pngSize(bytes) : jpegSize(bytes)
}

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return null
  // IHDR must be the first chunk.
  if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== 'IHDR') return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]!
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null // EOI / SOS before any SOF
    const length = (b[i + 2]! << 8) | b[i + 3]!
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (i + 8 >= b.length) return null
      return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! }
    }
    if (length < 2) return null
    i += 2 + length
  }
  return null
}
