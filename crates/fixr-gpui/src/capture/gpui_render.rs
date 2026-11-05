//! `capture-gpui-render` (opt-in): re-renders the window's last scene with
//! gpui's `Window::render_to_image`. That API only exists with gpui's
//! `test-support` feature, and in gpui-pre 0.3.11 only the macOS (Metal) and
//! Windows (DirectX) windows implement it; elsewhere it fails and the report
//! goes out with `capture_failed`. No permissions, no window-system access.

use gpui::{App, Window};

use super::{Capture, CaptureError, WindowCapturer};

#[derive(Debug, Clone, Copy, Default)]
pub struct GpuiRenderCapturer;

impl WindowCapturer for GpuiRenderCapturer {
    fn name(&self) -> &'static str {
        "gpui-render"
    }

    fn capture(&self, window: &mut Window, _cx: &mut App) -> Capture {
        Capture::Ready(
            window
                .render_to_image()
                .map_err(|e| CaptureError::Failed(format!("render_to_image: {e:#}"))),
        )
    }
}
