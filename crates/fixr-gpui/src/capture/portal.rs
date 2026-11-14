//! `capture-portal` (opt-in): xdg-desktop-portal `Screenshot` via ashpd.
//!
//! Works on Wayland, where a client can't read its own pixels. It is
//! interactive: the desktop shows its own screenshot dialog, and the result is
//! the whole screen or whatever the user picked there, not just our window.
//! Runs on its own thread so the app's event loop keeps going meanwhile.

use std::path::PathBuf;

use ashpd::desktop::screenshot::Screenshot;
use futures::channel::oneshot;
use gpui::{App, Window};

use super::{Capture, CaptureError, CaptureResult, WindowCapturer};

#[derive(Debug, Clone, Copy)]
pub struct PortalCapturer {
    /// Let the user pick the area/window in the portal dialog.
    pub interactive: bool,
}

impl Default for PortalCapturer {
    fn default() -> Self {
        Self { interactive: true }
    }
}

impl WindowCapturer for PortalCapturer {
    fn name(&self) -> &'static str {
        "portal"
    }

    fn capture(&self, _window: &mut Window, _cx: &mut App) -> Capture {
        let (tx, rx) = oneshot::channel();
        let interactive = self.interactive;
        let spawned = std::thread::Builder::new()
            .name("fixr-portal".into())
            .spawn(move || {
                let _ = tx.send(futures::executor::block_on(take(interactive)));
            });
        match spawned {
            Ok(_) => Capture::Pending(rx),
            Err(e) => Capture::Ready(Err(CaptureError::Failed(format!(
                "spawn portal thread: {e}"
            )))),
        }
    }
}

async fn take(interactive: bool) -> CaptureResult {
    let failed = |e: ashpd::Error| CaptureError::Failed(format!("screenshot portal: {e}"));
    let shot = Screenshot::request()
        .interactive(interactive)
        .modal(true)
        .send()
        .await
        .map_err(failed)?
        .response()
        .map_err(failed)?;
    let path = file_path(shot.uri().as_str())
        .ok_or_else(|| CaptureError::Failed(format!("unexpected screenshot URI {}", shot.uri())))?;
    let img = image::open(&path)
        .map_err(|e| CaptureError::Failed(format!("read {}: {e}", path.display())))?;
    // The portal leaves the file in ~/Pictures or similar; it's ours to clean up.
    let _ = std::fs::remove_file(&path);
    Ok(img.to_rgba8())
}

/// `file:///home/me/Pictures/Screenshot%20x.png` → path. Only local file URIs.
fn file_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    if !rest.starts_with('/') {
        return None;
    }
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = rest.get(i + 1..i + 3)
            && let Ok(b) = u8::from_str_radix(hex, 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    use std::os::unix::ffi::OsStringExt as _;
    Some(PathBuf::from(std::ffi::OsString::from_vec(out)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_file_uris() {
        assert_eq!(
            file_path("file:///home/me/Pictures/Screenshot%20from%202026.png"),
            Some(PathBuf::from("/home/me/Pictures/Screenshot from 2026.png"))
        );
        assert_eq!(
            file_path("file://localhost/tmp/a.png"),
            Some(PathBuf::from("/tmp/a.png"))
        );
        assert_eq!(file_path("https://example.com/a.png"), None);
    }
}
