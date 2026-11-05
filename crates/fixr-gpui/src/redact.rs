//! Black redaction rectangles: drawn in preview coordinates, burned into the
//! full-resolution capture before it is resized and encoded.

use image::{Rgba, RgbaImage};

/// A rectangle in preview coordinates (logical pixels, origin at the preview's
/// top-left corner). Corners may be given in any order.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Redaction {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl Redaction {
    pub fn from_corners(a: (f32, f32), b: (f32, f32)) -> Self {
        Self {
            x0: a.0.min(b.0),
            y0: a.1.min(b.1),
            x1: a.0.max(b.0),
            y1: a.1.max(b.1),
        }
    }

    pub fn width(&self) -> f32 {
        self.x1 - self.x0
    }

    pub fn height(&self) -> f32 {
        self.y1 - self.y0
    }

    /// Rectangles smaller than this (in preview pixels) are treated as stray clicks.
    pub fn is_meaningful(&self) -> bool {
        self.width() >= 3.0 && self.height() >= 3.0
    }

    /// Maps the rectangle onto an image of `image_size` pixels shown at
    /// `preview_size`, rounding outwards so nothing at the edge leaks, and
    /// clamping to the image. Returns `(x, y, w, h)` in image pixels, or `None`
    /// if nothing is left after clamping.
    pub fn to_image_pixels(&self, preview_size: (f32, f32), image_size: (u32, u32)) -> Option<(u32, u32, u32, u32)> {
        let (pw, ph) = preview_size;
        if pw <= 0.0 || ph <= 0.0 {
            return None;
        }
        let sx = image_size.0 as f32 / pw;
        let sy = image_size.1 as f32 / ph;
        let clamp_x = |v: f32| v.clamp(0.0, image_size.0 as f32);
        let clamp_y = |v: f32| v.clamp(0.0, image_size.1 as f32);
        let x0 = clamp_x((self.x0 * sx).floor()) as u32;
        let y0 = clamp_y((self.y0 * sy).floor()) as u32;
        let x1 = clamp_x((self.x1 * sx).ceil()) as u32;
        let y1 = clamp_y((self.y1 * sy).ceil()) as u32;
        (x1 > x0 && y1 > y0).then(|| (x0, y0, x1 - x0, y1 - y0))
    }
}

/// Paints every rectangle opaque black into `image`. The capture is never
/// sent without this having run first.
pub fn burn_in(image: &mut RgbaImage, redactions: &[Redaction], preview_size: (f32, f32)) {
    let dims = image.dimensions();
    for r in redactions {
        let Some((x, y, w, h)) = r.to_image_pixels(preview_size, dims) else {
            continue;
        };
        for py in y..y + h {
            for px in x..x + w {
                image.put_pixel(px, py, Rgba([0, 0, 0, 255]));
            }
        }
    }
}

/// The size at which an image of `image_size` pixels fits inside `max`
/// logical pixels, keeping the aspect ratio. Never upscales past 1:1 device
/// pixels at `scale`.
pub fn fit_preview(image_size: (u32, u32), max: (f32, f32), scale: f32) -> (f32, f32) {
    let (w, h) = (image_size.0.max(1) as f32, image_size.1.max(1) as f32);
    let natural = 1.0 / scale.max(0.1);
    let s = (max.0 / w).min(max.1 / h).min(natural);
    ((w * s).max(1.0), (h * s).max(1.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn white(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba([255, 255, 255, 255]))
    }

    #[test]
    fn preview_rect_is_scaled_to_image_pixels() {
        // 1280×800 image previewed at 320×200: factor 4.
        let r = Redaction::from_corners((20.0, 30.0), (10.0, 10.0));
        assert_eq!(r.to_image_pixels((320.0, 200.0), (1280, 800)), Some((40, 40, 40, 80)));
    }

    #[test]
    fn fractional_edges_round_outwards_and_clamp() {
        let r = Redaction::from_corners((-5.0, 0.3), (10.2, 500.0));
        // factor 2 on both axes; x0 clamps to 0, y0 floors to 0, x1 = ceil(20.4) = 21, y1 clamps to 400.
        assert_eq!(r.to_image_pixels((300.0, 200.0), (600, 400)), Some((0, 0, 21, 400)));
        let outside = Redaction::from_corners((400.0, 0.0), (500.0, 10.0));
        assert_eq!(outside.to_image_pixels((300.0, 200.0), (600, 400)), None);
    }

    #[test]
    fn burn_in_blackens_exactly_the_scaled_area() {
        let mut img = white(200, 100);
        // Preview at half size: (10,10)-(20,15) → pixels (20,20)-(40,30).
        burn_in(
            &mut img,
            &[Redaction::from_corners((10.0, 10.0), (20.0, 15.0))],
            (100.0, 50.0),
        );
        assert_eq!(img.get_pixel(20, 20).0, [0, 0, 0, 255]);
        assert_eq!(img.get_pixel(39, 29).0, [0, 0, 0, 255]);
        assert_eq!(img.get_pixel(40, 29).0, [255, 255, 255, 255]);
        assert_eq!(img.get_pixel(39, 30).0, [255, 255, 255, 255]);
        assert_eq!(img.get_pixel(19, 20).0, [255, 255, 255, 255]);
        let black = img.pixels().filter(|p| p.0 == [0, 0, 0, 255]).count();
        assert_eq!(black, 20 * 10);
    }

    #[test]
    fn non_uniform_scaling_uses_each_axis() {
        let mut img = white(100, 100);
        burn_in(
            &mut img,
            &[Redaction::from_corners((0.0, 0.0), (10.0, 10.0))],
            (50.0, 20.0),
        );
        // x factor 2, y factor 5.
        assert_eq!(img.get_pixel(19, 49).0, [0, 0, 0, 255]);
        assert_eq!(img.get_pixel(20, 0).0, [255, 255, 255, 255]);
        assert_eq!(img.get_pixel(0, 50).0, [255, 255, 255, 255]);
    }

    #[test]
    fn stray_clicks_are_not_meaningful() {
        assert!(!Redaction::from_corners((5.0, 5.0), (6.0, 30.0)).is_meaningful());
        assert!(Redaction::from_corners((5.0, 5.0), (9.0, 9.0)).is_meaningful());
    }

    #[test]
    fn preview_fits_box_and_keeps_aspect() {
        assert_eq!(fit_preview((2560, 1600), (608.0, 300.0), 2.0), (480.0, 300.0));
        // A tiny capture is not blown up beyond its natural size.
        assert_eq!(fit_preview((200, 100), (608.0, 300.0), 2.0), (100.0, 50.0));
    }
}
