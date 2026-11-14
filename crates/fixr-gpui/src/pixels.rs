//! Pixel-format conversions shared by the capturers and the preview.

use image::RgbaImage;

/// Byte order of a 32-bit-per-pixel X11 / CoreGraphics buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByteOrder {
    /// Little-endian `0xXXRRGGBB`: bytes in memory are `B, G, R, X`.
    LsbFirst,
    /// Big-endian `0xXXRRGGBB`: bytes in memory are `X, R, G, B`.
    MsbFirst,
}

/// Converts a 32 bpp `xRGB` buffer (what X11 `GetImage` returns for depth 24/32)
/// into an opaque RGBA image. `stride` is the length of one row in bytes and
/// may include padding. The alpha byte is ignored: on depth-24 visuals it is
/// undefined, and the screenshot is meant to be opaque anyway.
///
/// Returns `None` when the buffer is shorter than `stride * height` or the
/// stride can't hold `width` pixels.
pub fn xrgb32_to_rgba(
    data: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    order: ByteOrder,
) -> Option<RgbaImage> {
    let (w, h) = (width as usize, height as usize);
    if stride < w * 4 || data.len() < stride.checked_mul(h)? {
        return None;
    }
    let mut out = Vec::with_capacity(w * h * 4);
    for row in data.chunks_exact(stride).take(h) {
        for px in row[..w * 4].as_chunks::<4>().0 {
            let (r, g, b) = match order {
                ByteOrder::LsbFirst => (px[2], px[1], px[0]),
                ByteOrder::MsbFirst => (px[1], px[2], px[3]),
            };
            out.extend_from_slice(&[r, g, b, 255]);
        }
    }
    RgbaImage::from_raw(width, height, out)
}

/// Swaps the red and blue channels in place: RGBA ⇄ BGRA. gpui's
/// `RenderImage` wants BGRA, `fixr_client::image::prepare_rgba` wants RGBA.
pub fn swap_red_blue(pixels: &mut [u8]) {
    for px in pixels.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
    }
}

/// Converts premultiplied RGBA (CoreGraphics bitmap contexts) to straight RGBA.
pub fn unpremultiply(pixels: &mut [u8]) {
    for px in pixels.as_chunks_mut::<4>().0 {
        let a = u16::from(px[3]);
        if a == 0 || a == 255 {
            continue;
        }
        for c in &mut px[..3] {
            *c = ((u16::from(*c) * 255 + a / 2) / a).min(255) as u8;
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn lsb_first_bgrx_becomes_rgba_and_padding_is_skipped() {
        // 2×2 image, stride 12 (one pixel of padding per row).
        #[rustfmt::skip]
        let data = [
            1, 2, 3, 0,    4, 5, 6, 0,    99, 99, 99, 99,
            7, 8, 9, 0,   10, 11, 12, 0,  99, 99, 99, 99,
        ];
        let img = xrgb32_to_rgba(&data, 2, 2, 12, ByteOrder::LsbFirst).unwrap();
        assert_eq!(img.get_pixel(0, 0).0, [3, 2, 1, 255]);
        assert_eq!(img.get_pixel(1, 0).0, [6, 5, 4, 255]);
        assert_eq!(img.get_pixel(0, 1).0, [9, 8, 7, 255]);
        assert_eq!(img.get_pixel(1, 1).0, [12, 11, 10, 255]);
    }

    #[test]
    fn msb_first_xrgb_becomes_rgba() {
        let data = [0, 10, 20, 30];
        let img = xrgb32_to_rgba(&data, 1, 1, 4, ByteOrder::MsbFirst).unwrap();
        assert_eq!(img.get_pixel(0, 0).0, [10, 20, 30, 255]);
    }

    #[test]
    fn short_buffers_are_rejected() {
        assert!(xrgb32_to_rgba(&[0; 7], 1, 2, 4, ByteOrder::LsbFirst).is_none());
        assert!(xrgb32_to_rgba(&[0; 8], 2, 1, 4, ByteOrder::LsbFirst).is_none());
    }

    #[test]
    fn swap_is_an_involution() {
        let mut px = vec![1, 2, 3, 4, 5, 6, 7, 8];
        swap_red_blue(&mut px);
        assert_eq!(px, [3, 2, 1, 4, 7, 6, 5, 8]);
        swap_red_blue(&mut px);
        assert_eq!(px, [1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn unpremultiply_restores_straight_alpha() {
        let mut px = vec![64, 32, 0, 128, 10, 20, 30, 255, 5, 5, 5, 0];
        unpremultiply(&mut px);
        assert_eq!(px, [128, 64, 0, 128, 10, 20, 30, 255, 5, 5, 5, 0]);
    }
}
