//! `capture-x11`: `GetImage` on our own X11 window over a fresh x11rb
//! connection. Window ids are server-global, so the id from gpui's raw handle
//! is valid on our connection; no unsafe, no access to gpui's connection.

use gpui::{App, Window};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use x11rb::connection::Connection as _;
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, ImageOrder};
use x11rb::rust_connection::RustConnection;

use super::{Capture, CaptureError, CaptureResult, WindowCapturer, reason};
use crate::pixels::{ByteOrder, xrgb32_to_rgba};

#[derive(Debug, Clone, Copy, Default)]
pub struct X11Capturer;

impl WindowCapturer for X11Capturer {
    fn name(&self) -> &'static str {
        "x11"
    }

    fn capture(&self, window: &mut Window, _cx: &mut App) -> Capture {
        let id = match HasWindowHandle::window_handle(window).map(|h| h.as_raw()) {
            Ok(RawWindowHandle::Xcb(h)) => h.window.get(),
            Ok(RawWindowHandle::Xlib(h)) => match u32::try_from(h.window) {
                Ok(id) => id,
                Err(_) => {
                    return Capture::Ready(Err(CaptureError::Failed(
                        "Xlib window id out of range".into(),
                    )));
                }
            },
            Ok(RawWindowHandle::Wayland(_)) => {
                return Capture::unsupported(reason::WAYLAND_UNSUPPORTED);
            }
            _ => return Capture::unsupported(reason::UNSUPPORTED),
        };
        Capture::Ready(capture_window(id))
    }
}

fn failed(what: &str, e: impl std::fmt::Display) -> CaptureError {
    CaptureError::Failed(format!("{what}: {e}"))
}

/// Grabs the current contents of X11 window `id` as RGBA.
pub fn capture_window(id: u32) -> CaptureResult {
    let (conn, _screen) =
        RustConnection::connect(None).map_err(|e| failed("connect to X server", e))?;
    let geom = conn
        .get_geometry(id)
        .map_err(|e| failed("GetGeometry", e))?
        .reply()
        .map_err(|e| failed("GetGeometry", e))?;
    let (w, h) = (geom.width, geom.height);
    if w == 0 || h == 0 {
        return Err(CaptureError::Failed("window has no area".into()));
    }
    let img = conn
        .get_image(ImageFormat::Z_PIXMAP, id, 0, 0, w, h, !0)
        .map_err(|e| failed("GetImage", e))?
        .reply()
        .map_err(|e| failed("GetImage", e))?;

    let setup = conn.setup();
    let bpp = setup
        .pixmap_formats
        .iter()
        .find(|f| f.depth == img.depth)
        .map_or(0, |f| f.bits_per_pixel);
    if bpp != 32 || img.depth < 24 {
        return Err(CaptureError::Failed(format!(
            "unsupported pixel format: depth {} at {bpp} bpp",
            img.depth
        )));
    }
    let order = if setup.image_byte_order == ImageOrder::MSB_FIRST {
        ByteOrder::MsbFirst
    } else {
        ByteOrder::LsbFirst
    };
    let stride = img.data.len() / usize::from(h);
    xrgb32_to_rgba(&img.data, u32::from(w), u32::from(h), stride, order)
        .ok_or_else(|| CaptureError::Failed("GetImage returned a short buffer".into()))
}
