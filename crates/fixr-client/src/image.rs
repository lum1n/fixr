//! The image ladder from `spec/wire-format.md`: long edge ≤ 2000 px, PNG if it
//! fits in 2 MB, else JPEG 0.9→0.5, else scale ×0.75 and repeat.

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ImageEncoder as _, RgbaImage};

use crate::Limits;

/// Smallest long edge worth sending.
const MIN_EDGE: u32 = 200;
const JPEG_QUALITIES: [u8; 5] = [90, 80, 70, 60, 50];

/// An encoded screenshot ready to upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    /// `image/png` or `image/jpeg`.
    pub mime: String,
    pub bytes: Vec<u8>,
}

impl Image {
    pub fn extension(&self) -> &'static str {
        if self.mime == "image/jpeg" { "jpg" } else { "png" }
    }

    pub fn from_file_bytes(bytes: Vec<u8>) -> Option<Self> {
        let mime = match image::guess_format(&bytes).ok()? {
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::Jpeg => "image/jpeg",
            _ => return None,
        };
        Some(Self { mime: mime.into(), bytes })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PrepareError {
    #[error("can't decode image: {0}")]
    Decode(#[from] image::ImageError),
    /// Even the smallest JPEG didn't fit: send `screenshot_omitted_reason: "too_large"`.
    #[error("image doesn't fit the size limit")]
    TooLarge,
}

/// Decodes any supported image and runs the ladder. An image already within
/// limits (PNG or JPEG, small enough) is passed through unchanged.
pub fn prepare_bytes(bytes: &[u8], limits: &Limits) -> Result<Image, PrepareError> {
    let img = image::load_from_memory(bytes)?;
    if let Some(passthrough) = Image::from_file_bytes(bytes.to_vec())
        && passthrough.bytes.len() <= limits.max_image_bytes
        && img.width().max(img.height()) <= limits.max_image_dimension
    {
        return Ok(passthrough);
    }
    prepare(img, limits)
}

/// Runs the ladder on raw RGBA pixels (a window capture).
pub fn prepare_rgba(pixels: RgbaImage, limits: &Limits) -> Result<Image, PrepareError> {
    prepare(DynamicImage::ImageRgba8(pixels), limits)
}

pub fn prepare(img: DynamicImage, limits: &Limits) -> Result<Image, PrepareError> {
    let mut img = fit(img, limits.max_image_dimension);
    loop {
        let png = encode_png(&img)?;
        if png.len() <= limits.max_image_bytes {
            return Ok(Image { mime: "image/png".into(), bytes: png });
        }
        let rgb = DynamicImage::ImageRgb8(img.to_rgb8());
        for q in JPEG_QUALITIES {
            let jpg = encode_jpeg(&rgb, q)?;
            if jpg.len() <= limits.max_image_bytes {
                return Ok(Image { mime: "image/jpeg".into(), bytes: jpg });
            }
        }
        let long = img.width().max(img.height());
        let next = (f64::from(long) * 0.75) as u32;
        if next < MIN_EDGE {
            return Err(PrepareError::TooLarge);
        }
        img = fit(img, next);
    }
}

fn fit(img: DynamicImage, max_edge: u32) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    let long = w.max(h);
    if long <= max_edge {
        return img;
    }
    let s = f64::from(max_edge) / f64::from(long);
    let nw = ((f64::from(w) * s).round() as u32).max(1);
    let nh = ((f64::from(h) * s).round() as u32).max(1);
    img.resize_exact(nw, nh, FilterType::Triangle)
}

fn encode_png(img: &DynamicImage) -> Result<Vec<u8>, image::ImageError> {
    let mut out = Vec::new();
    let rgba = img.to_rgba8();
    PngEncoder::new(&mut out).write_image(
        rgba.as_raw(),
        rgba.width(),
        rgba.height(),
        image::ExtendedColorType::Rgba8,
    )?;
    Ok(out)
}

fn encode_jpeg(img: &DynamicImage, quality: u8) -> Result<Vec<u8>, image::ImageError> {
    let mut out = Vec::new();
    let rgb = img.to_rgb8();
    JpegEncoder::new_with_quality(&mut out, quality).write_image(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn noise(w: u32, h: u32) -> RgbaImage {
        // Deterministic pseudo-random pixels so PNG can't compress them.
        let mut x: u32 = 0x1234_5678;
        RgbaImage::from_fn(w, h, |_, _| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            image::Rgba([x as u8, (x >> 8) as u8, (x >> 16) as u8, 255])
        })
    }

    #[test]
    fn small_flat_image_stays_png() {
        let img = RgbaImage::from_pixel(300, 200, image::Rgba([10, 20, 30, 255]));
        let out = prepare_rgba(img, &Limits::default()).unwrap();
        assert_eq!(out.mime, "image/png");
    }

    #[test]
    fn long_edge_is_capped() {
        let img = RgbaImage::from_pixel(4000, 1000, image::Rgba([0, 0, 0, 255]));
        let out = prepare_rgba(img, &Limits::default()).unwrap();
        let d = image::load_from_memory(&out.bytes).unwrap();
        assert_eq!((d.width(), d.height()), (2000, 500));
    }

    #[test]
    fn noisy_image_falls_back_to_jpeg_within_budget() {
        let limits = Limits { max_image_bytes: 200_000, ..Limits::default() };
        let out = prepare_rgba(noise(800, 600), &limits).unwrap();
        assert_eq!(out.mime, "image/jpeg");
        assert!(out.bytes.len() <= 200_000);
    }

    #[test]
    fn impossible_budget_is_too_large() {
        let limits = Limits { max_image_bytes: 100, ..Limits::default() };
        assert!(matches!(prepare_rgba(noise(400, 400), &limits), Err(PrepareError::TooLarge)));
    }

    #[test]
    fn small_png_file_passes_through() {
        let img = DynamicImage::ImageRgba8(RgbaImage::from_pixel(10, 10, image::Rgba([1, 2, 3, 255])));
        let png = encode_png(&img).unwrap();
        let out = prepare_bytes(&png, &Limits::default()).unwrap();
        assert_eq!(out.bytes, png);
    }
}
