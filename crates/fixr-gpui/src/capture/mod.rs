//! Capturing our own window. One file per backend because gpui and the
//! platform crates drift; each is behind its own feature.
//!
//! | feature               | default      | how                                            |
//! |-----------------------|--------------|------------------------------------------------|
//! | `capture-macos`       | yes (macOS)  | `CGWindowListCreateImage` on our window number |
//! | `capture-x11`         | yes (Linux)  | x11rb `GetImage` on our X11 window             |
//! | `capture-portal`      | no           | xdg-desktop-portal Screenshot (Wayland)        |
//! | `capture-gpui-render` | no           | gpui `Window::render_to_image` (test-support)  |

#[cfg(feature = "capture-gpui-render")]
mod gpui_render;
#[cfg(all(target_os = "macos", feature = "capture-macos"))]
mod macos;
#[cfg(all(any(target_os = "linux", target_os = "freebsd"), feature = "capture-portal"))]
mod portal;
#[cfg(all(any(target_os = "linux", target_os = "freebsd"), feature = "capture-x11"))]
mod x11;

use std::fmt;
use std::sync::Arc;

use futures::channel::oneshot;
use gpui::{App, Window};
use image::RgbaImage;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

#[cfg(feature = "capture-gpui-render")]
pub use self::gpui_render::GpuiRenderCapturer;
#[cfg(all(target_os = "macos", feature = "capture-macos"))]
pub use self::macos::MacCapturer;
#[cfg(all(any(target_os = "linux", target_os = "freebsd"), feature = "capture-portal"))]
pub use self::portal::PortalCapturer;
#[cfg(all(any(target_os = "linux", target_os = "freebsd"), feature = "capture-x11"))]
pub use self::x11::X11Capturer;

/// `screenshot_omitted_reason` tokens this crate sends.
pub mod reason {
    pub const CAPTURE_FAILED: &str = "capture_failed";
    pub const CAPTURE_DISABLED: &str = "capture_disabled";
    pub const WAYLAND_UNSUPPORTED: &str = "wayland_unsupported";
    pub const USER_REMOVED: &str = "user_removed";
    pub const TOO_LARGE: &str = "too_large";
    /// No capturer for this platform/window system was compiled in.
    pub const UNSUPPORTED: &str = "capture_unsupported";
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureError {
    /// Capture isn't possible here; the token becomes `screenshot_omitted_reason`.
    Unsupported(&'static str),
    /// Capture was attempted and failed; sent as `capture_failed`.
    Failed(String),
}

impl CaptureError {
    pub fn omitted_reason(&self) -> &'static str {
        match self {
            Self::Unsupported(r) => r,
            Self::Failed(_) => reason::CAPTURE_FAILED,
        }
    }
}

impl fmt::Display for CaptureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported(r) => write!(f, "capture unsupported ({r})"),
            Self::Failed(e) => write!(f, "capture failed: {e}"),
        }
    }
}

impl std::error::Error for CaptureError {}

pub type CaptureResult = Result<RgbaImage, CaptureError>;

/// What a capturer returns: the pixels now, or later (portal dialogs).
#[derive(Debug)]
pub enum Capture {
    Ready(CaptureResult),
    /// Finished on another thread; the overlay opens when it resolves.
    Pending(oneshot::Receiver<CaptureResult>),
}

impl Capture {
    pub fn unsupported(reason: &'static str) -> Self {
        Self::Ready(Err(CaptureError::Unsupported(reason)))
    }
}

/// Captures the pixels of the window being reported, in device pixels, RGBA.
///
/// Called on the main thread on `OpenReport`, before the overlay exists.
pub trait WindowCapturer: 'static {
    fn name(&self) -> &'static str;
    fn capture(&self, window: &mut Window, cx: &mut App) -> Capture;
}

#[derive(Clone, Default)]
pub enum CaptureStrategy {
    /// Pick by window system: macOS → `capture-macos`; X11 → `capture-x11`;
    /// Wayland → `capture-portal` if enabled, else no screenshot
    /// (`wayland_unsupported`). Falls back to `capture-gpui-render` if enabled.
    #[default]
    Auto,
    /// Never capture (`capture_disabled`).
    Disabled,
    Custom(Arc<dyn WindowCapturer>),
}

impl fmt::Debug for CaptureStrategy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Auto => f.write_str("Auto"),
            Self::Disabled => f.write_str("Disabled"),
            Self::Custom(c) => write!(f, "Custom({})", c.name()),
        }
    }
}

impl CaptureStrategy {
    pub fn capture(&self, window: &mut Window, cx: &mut App) -> Capture {
        match self {
            Self::Auto => auto(window, cx),
            Self::Disabled => Capture::unsupported(reason::CAPTURE_DISABLED),
            Self::Custom(c) => c.capture(window, cx),
        }
    }
}

/// Which window system the window lives on, from its raw handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowSystem {
    AppKit,
    X11,
    Wayland,
    Other,
}

pub(crate) fn window_system(window: &Window) -> WindowSystem {
    match HasWindowHandle::window_handle(window).map(|h| h.as_raw()) {
        Ok(RawWindowHandle::AppKit(_)) => WindowSystem::AppKit,
        Ok(RawWindowHandle::Xcb(_) | RawWindowHandle::Xlib(_)) => WindowSystem::X11,
        Ok(RawWindowHandle::Wayland(_)) => WindowSystem::Wayland,
        _ => WindowSystem::Other,
    }
}

#[allow(unused_variables, unreachable_code)]
fn auto(window: &mut Window, cx: &mut App) -> Capture {
    match window_system(window) {
        WindowSystem::AppKit => {
            #[cfg(all(target_os = "macos", feature = "capture-macos"))]
            return MacCapturer.capture(window, cx);
        }
        WindowSystem::X11 => {
            #[cfg(all(any(target_os = "linux", target_os = "freebsd"), feature = "capture-x11"))]
            return X11Capturer.capture(window, cx);
        }
        WindowSystem::Wayland => {
            #[cfg(all(any(target_os = "linux", target_os = "freebsd"), feature = "capture-portal"))]
            return PortalCapturer::default().capture(window, cx);
            return Capture::unsupported(reason::WAYLAND_UNSUPPORTED);
        }
        WindowSystem::Other => {}
    }
    #[cfg(feature = "capture-gpui-render")]
    return GpuiRenderCapturer.capture(window, cx);
    Capture::unsupported(reason::UNSUPPORTED)
}
