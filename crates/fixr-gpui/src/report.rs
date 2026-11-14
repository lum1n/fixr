//! Building the wire-format report from the config and what was gathered when
//! the overlay opened. Pure; no gpui types.

use std::collections::BTreeMap;

use fixr_client::{App, Context, Device, Report, Screen, Sdk};

use crate::{FixrConfig, SDK_NAME, SDK_VERSION};

/// App-supplied metadata, gathered on `OpenReport` (see [`FixrConfig::metadata`]).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Metadata {
    /// App build number (`app.build`).
    pub build: Option<String>,
    /// Current screen/view name and title; fields left `None` keep the defaults
    /// fixr gathered itself (the window title).
    pub context: Context,
    /// Free-form `extra` map (≤ 32 keys, keys ≤ 64 chars, values ≤ 1000 chars).
    pub extra: BTreeMap<String, String>,
}

/// Everything known about the app when the overlay opened, before the user typed.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Snapshot {
    pub device: Device,
    pub locale: Option<String>,
    pub window_title: Option<String>,
    pub metadata: Metadata,
}

impl Snapshot {
    /// The host's device info plus the window's display in points.
    pub fn gather(
        window_title: Option<String>,
        screen: Option<Screen>,
        metadata: Metadata,
    ) -> Self {
        let mut device = fixr_client::metadata::host_device_info();
        device.screen = screen;
        Self {
            device,
            locale: fixr_client::metadata::host_locale(),
            window_title: window_title.filter(|t| !t.trim().is_empty()),
            metadata,
        }
    }
}

/// Builds the report document. `omitted_reason` is set when no screenshot
/// goes with it. Does not validate; call [`Report::validate`] afterwards.
pub(crate) fn build_report(
    config: &FixrConfig,
    snapshot: &Snapshot,
    prompt: &str,
    omitted_reason: Option<&str>,
) -> Report {
    let sdk = Sdk {
        name: SDK_NAME.into(),
        version: SDK_VERSION.into(),
    };
    let app = App {
        id: config.app_id.clone(),
        version: config.app_version.clone(),
        build: snapshot.metadata.build.clone(),
    };
    let mut report = Report::new(prompt.trim(), sdk, app, snapshot.device.clone());
    report.locale = snapshot.locale.clone();
    let meta = &snapshot.metadata.context;
    let context = Context {
        screen: meta.screen.clone(),
        title: meta.title.clone().or_else(|| snapshot.window_title.clone()),
        url: meta.url.clone(),
    };
    if context != Context::default() {
        report.context = Some(context);
    }
    report.screenshot_omitted_reason = omitted_reason.map(str::to_owned);
    report.extra = snapshot.metadata.extra.clone();
    report
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use fixr_client::{Limits, Platform};

    use super::*;

    fn config() -> FixrConfig {
        FixrConfig {
            app_version: Some("1.2.3".into()),
            ..FixrConfig::new("http://localhost:8787", "key", "com.example.demo")
        }
    }

    fn snapshot(metadata: Metadata) -> Snapshot {
        Snapshot {
            device: Device {
                platform: Platform::Linux,
                os_version: Some("Arch Linux (6.12)".into()),
                model: None,
                screen: Some(Screen {
                    width: 1920,
                    height: 1080,
                    scale: 2.0,
                }),
            },
            locale: Some("en-US".into()),
            window_title: Some("Demo".into()),
            metadata,
        }
    }

    #[test]
    fn report_carries_config_sdk_and_window_title() {
        let r = build_report(
            &config(),
            &snapshot(Metadata::default()),
            "  The button is off  \n",
            None,
        );
        assert_eq!(r.prompt, "The button is off");
        assert_eq!(r.sdk.name, "fixr-gpui");
        assert_eq!(r.sdk.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(r.app.id, "com.example.demo");
        assert_eq!(r.app.version.as_deref(), Some("1.2.3"));
        assert_eq!(r.app.build, None);
        assert_eq!(r.device.screen.unwrap().width, 1920);
        assert_eq!(r.locale.as_deref(), Some("en-US"));
        assert_eq!(
            r.context.as_ref().and_then(|c| c.title.as_deref()),
            Some("Demo")
        );
        assert_eq!(r.screenshot_omitted_reason, None);
        assert!(r.validate(&Limits::default()).is_ok());

        let json: serde_json::Value = serde_json::from_slice(&r.to_json()).unwrap();
        assert_eq!(json["schema"], 1);
        assert_eq!(json["device"]["platform"], "linux");
        assert!(json.get("extra").is_none(), "empty extra is omitted");
    }

    #[test]
    fn metadata_overrides_defaults_and_reason_is_recorded() {
        let meta = Metadata {
            build: Some("42".into()),
            context: Context {
                screen: Some("SettingsView".into()),
                title: Some("Settings".into()),
                url: None,
            },
            extra: BTreeMap::from([("branch".to_owned(), "main".to_owned())]),
        };
        let r = build_report(&config(), &snapshot(meta), "x", Some("wayland_unsupported"));
        assert_eq!(r.app.build.as_deref(), Some("42"));
        let ctx = r.context.unwrap();
        assert_eq!(ctx.screen.as_deref(), Some("SettingsView"));
        assert_eq!(ctx.title.as_deref(), Some("Settings"));
        assert_eq!(r.extra["branch"], "main");
        assert_eq!(
            r.screenshot_omitted_reason.as_deref(),
            Some("wayland_unsupported")
        );
    }

    #[test]
    fn no_context_when_nothing_is_known() {
        let mut s = snapshot(Metadata::default());
        s.window_title = None;
        let r = build_report(&config(), &s, "x", None);
        assert!(r.context.is_none());
    }

    #[test]
    fn blank_window_titles_are_dropped() {
        let s = Snapshot::gather(Some("  ".into()), None, Metadata::default());
        assert_eq!(s.window_title, None);
    }
}
