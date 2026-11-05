//! `capture-macos`: `CGWindowListCreateImage` on our own window.
//!
//! Composited pixels (Metal, web views, everything), and capturing a window
//! owned by the calling process is not gated by Screen Recording permission.
//! The API is deprecated since macOS 14 in favour of ScreenCaptureKit but
//! still works on 14 and 15.
//!
//! NOTE: this file is only compiled on macOS and was written without a Mac to
//! build it on; see the crate README.
#![allow(unsafe_code)]

use std::ffi::c_void;

use gpui::{App, Window};
use objc2_app_kit::NSView;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
#[allow(deprecated)]
use objc2_core_graphics::CGWindowListCreateImage;
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapInfo, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo, CGRectNull,
    CGWindowImageOption, CGWindowListOption,
};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

use super::{Capture, CaptureError, CaptureResult, WindowCapturer, reason};
use crate::pixels::unpremultiply;

#[derive(Debug, Clone, Copy, Default)]
pub struct MacCapturer;

impl WindowCapturer for MacCapturer {
    fn name(&self) -> &'static str {
        "macos"
    }

    fn capture(&self, window: &mut Window, _cx: &mut App) -> Capture {
        let handle = match HasWindowHandle::window_handle(window).map(|h| h.as_raw()) {
            Ok(RawWindowHandle::AppKit(h)) => h,
            _ => return Capture::unsupported(reason::UNSUPPORTED),
        };
        // SAFETY: gpui's AppKit handle points at the window's live content
        // NSView, and we're on the main thread inside a window update, so the
        // view outlives this borrow.
        let view: &NSView = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
        let Some(ns_window) = view.window() else {
            return Capture::Ready(Err(CaptureError::Failed("view has no NSWindow".into())));
        };
        let number = ns_window.windowNumber();
        let Ok(number) = u32::try_from(number) else {
            return Capture::Ready(Err(CaptureError::Failed(format!("bad window number {number}"))));
        };
        Capture::Ready(capture_window_number(number))
    }
}

fn failed(msg: &str) -> CaptureError {
    CaptureError::Failed(msg.into())
}

/// Captures window `number` (a `CGWindowID`) at backing resolution, without
/// its frame/shadow, as straight-alpha RGBA.
#[allow(deprecated)]
pub fn capture_window_number(number: u32) -> CaptureResult {
    // SAFETY: CGRectNull is an immutable CoreGraphics constant.
    let null_rect = unsafe { CGRectNull };
    let image = CGWindowListCreateImage(
        null_rect,
        CGWindowListOption::OptionIncludingWindow,
        number,
        CGWindowImageOption::BoundsIgnoreFraming | CGWindowImageOption::BestResolution,
    )
    .ok_or_else(|| failed("CGWindowListCreateImage returned nothing"))?;

    let width = CGImage::width(Some(&image));
    let height = CGImage::height(Some(&image));
    if width == 0 || height == 0 {
        return Err(failed("captured image is empty"));
    }

    // Draw into an RGBA8 buffer we own, whatever the source layout is.
    let stride = width * 4;
    let mut pixels = vec![0u8; stride * height];
    let space = CGColorSpace::new_device_rgb().ok_or_else(|| failed("no RGB colour space"))?;
    let info = CGImageAlphaInfo::PremultipliedLast.0 | CGBitmapInfo::ByteOrder32Big.bits();
    // SAFETY: `pixels` is `stride * height` bytes and outlives `context`,
    // which is dropped at the end of this function.
    let context = unsafe {
        CGBitmapContextCreate(
            pixels.as_mut_ptr().cast::<c_void>(),
            width,
            height,
            8,
            stride,
            Some(&space),
            info,
        )
    }
    .ok_or_else(|| failed("CGBitmapContextCreate failed"))?;
    let rect = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(width as f64, height as f64));
    CGContext::draw_image(Some(&context), rect, Some(&image));
    drop(context);

    // A window that is off screen or minimised comes back fully transparent.
    if pixels.as_chunks::<4>().0.iter().all(|p| p[3] == 0) {
        return Err(failed("captured image is transparent (window not on screen?)"));
    }
    unpremultiply(&mut pixels);
    let (w, h) = (
        u32::try_from(width).map_err(|_| failed("image too wide"))?,
        u32::try_from(height).map_err(|_| failed("image too tall"))?,
    );
    image::RgbaImage::from_raw(w, h, pixels).ok_or_else(|| failed("pixel buffer size mismatch"))
}
