//! fixr for gpui apps.
//!
//! ```ignore
//! fixr_gpui::init(cx, fixr_gpui::FixrConfig::new(endpoint, project_key, "com.example.app"));
//! // cmd-shift-f (macOS) / ctrl-shift-f opens the reporter for the active window,
//! // or call fixr_gpui::open_report(window, cx) yourself.
//! ```
//!
//! On `OpenReport` the active window is captured (before anything else is
//! drawn), then a small overlay window shows the capture, lets the user drag
//! black redaction boxes over it and type a prompt. Send hands the report to a
//! background [`fixr_client::Sender`] and closes the overlay immediately;
//! delivery and retries happen off the UI thread, persisted on disk.

/// `cmd-<keys>` on macOS, `ctrl-<keys>` elsewhere (gpui's `cmd` means Super on Linux).
#[cfg(target_os = "macos")]
macro_rules! primary {
    ($keys:literal) => {
        concat!("cmd-", $keys)
    };
}
#[cfg(not(target_os = "macos"))]
macro_rules! primary {
    ($keys:literal) => {
        concat!("ctrl-", $keys)
    };
}

pub mod capture;
mod overlay;
pub mod pixels;
pub mod redact;
mod report;
mod text_area;

use std::fmt;
use std::sync::Arc;

use fixr_client::{Client, ClientConfig, DiskQueue, Screen, Sender};
use gpui::{AnyWindowHandle, App, Global, KeyBinding, Window, actions};

pub use crate::capture::{Capture, CaptureError, CaptureStrategy, WindowCapturer};
pub use crate::report::Metadata;
pub use fixr_client::{Context, Limits};

/// `sdk.name` in every report.
pub const SDK_NAME: &str = "fixr-gpui";
/// `sdk.version` in every report.
pub const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Key context of the overlay window's root, for custom key bindings.
pub const OVERLAY_CONTEXT: &str = "FixrOverlay";

actions!(
    fixr,
    [
        /// Capture the active window and open the report overlay.
        OpenReport,
        /// Send the report shown in the overlay.
        SendReport,
        /// Close the overlay without sending.
        CancelReport,
        /// Switch drag-to-redact on or off in the overlay.
        ToggleRedact,
    ]
);

/// Called on `OpenReport` with the window being reported.
pub type MetadataProvider = Arc<dyn Fn(&Window, &App) -> Metadata>;

/// Configuration for [`init`].
#[derive(Clone)]
pub struct FixrConfig {
    /// Worker base URL, e.g. `https://fixr.example.workers.dev`.
    pub endpoint: String,
    pub project_key: String,
    /// `app.id`, also names the on-disk retry queue.
    pub app_id: String,
    pub app_version: Option<String>,
    /// Extra context gathered when the overlay opens.
    pub metadata: Option<MetadataProvider>,
    pub capture: CaptureStrategy,
    pub limits: Limits,
    /// Bind `cmd-shift-f` / `ctrl-shift-f` to [`OpenReport`] (default true).
    /// Turn off when the app already uses that key and opens the overlay
    /// some other way (a menu, a command palette, [`open_report`]).
    pub bind_open_shortcut: bool,
}

impl FixrConfig {
    pub fn new(endpoint: impl Into<String>, project_key: impl Into<String>, app_id: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            project_key: project_key.into(),
            app_id: app_id.into(),
            app_version: None,
            metadata: None,
            capture: CaptureStrategy::Auto,
            limits: Limits::default(),
            bind_open_shortcut: true,
        }
    }
}

impl fmt::Debug for FixrConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FixrConfig")
            .field("endpoint", &self.endpoint)
            .field("project_key", &"…")
            .field("app_id", &self.app_id)
            .field("app_version", &self.app_version)
            .field("metadata", &self.metadata.as_ref().map(|_| "Fn"))
            .field("capture", &self.capture)
            .field("limits", &self.limits)
            .field("bind_open_shortcut", &self.bind_open_shortcut)
            .finish()
    }
}

pub(crate) struct Fixr {
    pub config: FixrConfig,
    pub sender: Arc<Sender>,
    pub overlay: Option<AnyWindowHandle>,
}

impl Global for Fixr {}

/// Starts the background sender (which also retries anything left in the
/// queue from earlier runs), registers the actions and binds the default keys:
/// `cmd-shift-f` on macOS, `ctrl-shift-f` elsewhere (unless
/// [`FixrConfig::bind_open_shortcut`] is off), plus the overlay's own keys.
pub fn init(cx: &mut App, config: FixrConfig) {
    let client = Client::new(ClientConfig::new(
        &config.endpoint,
        &config.project_key,
        SDK_NAME,
        SDK_VERSION,
    ));
    let sender = Arc::new(Sender::start(client, DiskQueue::default_for(&config.app_id)));
    let bindings = key_bindings(config.bind_open_shortcut);
    cx.set_global(Fixr {
        config,
        sender,
        overlay: None,
    });
    cx.bind_keys(bindings);
    cx.on_action(|_: &OpenReport, cx: &mut App| {
        // Without a window manager reporting focus (bare X servers) gpui knows no
        // active window; fall back to the first window that isn't our overlay.
        let overlay = cx.try_global::<Fixr>().and_then(|f| f.overlay);
        let Some(handle) = cx
            .active_window()
            .or_else(|| cx.windows().into_iter().find(|w| Some(*w) != overlay))
        else {
            log::warn!("fixr: OpenReport without a window");
            return;
        };
        // The window is leased while its key event is dispatched; run once it's free.
        cx.defer(move |cx| {
            if let Err(e) = handle.update(cx, |_, window, cx| open_report(window, cx)) {
                log::warn!("fixr: can't open the report overlay: {e:#}");
            }
        });
    });
}

/// The bindings [`init`] installs, for apps that rebuild their keymap.
pub fn default_key_bindings() -> Vec<KeyBinding> {
    key_bindings(true)
}

/// The overlay's bindings, with or without the global [`OpenReport`] key.
pub fn key_bindings(open_shortcut: bool) -> Vec<KeyBinding> {
    let overlay = Some(OVERLAY_CONTEXT);
    let mut bindings = Vec::new();
    if open_shortcut {
        bindings.push(KeyBinding::new(primary!("shift-f"), OpenReport, None));
    }
    bindings.extend([
        KeyBinding::new("escape", CancelReport, overlay),
        KeyBinding::new(primary!("enter"), SendReport, overlay),
        KeyBinding::new(primary!("shift-r"), ToggleRedact, overlay),
    ]);
    bindings.extend(text_area::key_bindings());
    bindings
}

/// Captures `window` and opens the report overlay for it. Does nothing (but
/// focus the existing overlay) if one is already open.
pub fn open_report(window: &mut Window, cx: &mut App) {
    let Some(state) = cx.try_global::<Fixr>() else {
        log::warn!("fixr: open_report called before fixr_gpui::init");
        return;
    };
    let existing = state.overlay;
    let strategy = state.config.capture.clone();
    let provider = state.config.metadata.clone();
    if let Some(existing) = existing
        && existing.update(cx, |_, w, _| w.activate_window()).is_ok()
    {
        return;
    }

    // Capture first, while nothing of ours is on screen.
    let capture = strategy.capture(window, cx);

    let metadata = provider.map(|p| p(window, cx)).unwrap_or_default();
    let screen = window.display(cx).map(|d| {
        let size = d.bounds().size;
        Screen {
            width: f32::from(size.width).round() as u32,
            height: f32::from(size.height).round() as u32,
            scale: f64::from(window.scale_factor()),
        }
    });
    let snapshot = report::Snapshot::gather(Some(window.window_title()), screen, metadata);
    let parent = overlay::Parent::of(window, cx);

    match capture {
        Capture::Ready(result) => overlay::open(result, snapshot, parent, cx),
        Capture::Pending(rx) => cx
            .spawn(async move |cx| {
                let result = rx
                    .await
                    .unwrap_or_else(|_| Err(CaptureError::Failed("capture was cancelled".into())));
                cx.update(|cx| overlay::open(result, snapshot, parent, cx));
            })
            .detach(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opens(bindings: &[KeyBinding]) -> usize {
        bindings
            .iter()
            .filter(|b| b.action().as_any().is::<OpenReport>())
            .count()
    }

    #[test]
    fn open_shortcut_is_optional() {
        let with = key_bindings(true);
        let without = key_bindings(false);
        assert_eq!(opens(&with), 1);
        assert_eq!(opens(&without), 0);
        assert_eq!(with.len(), without.len() + 1);
        assert_eq!(opens(&default_key_bindings()), 1);
    }

    #[test]
    fn config_binds_the_shortcut_by_default() {
        assert!(FixrConfig::new("http://x", "k", "a").bind_open_shortcut);
    }
}
