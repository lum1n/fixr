//! The report document (`spec/report.schema.json`, schema 1).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::Limits;

pub const SCHEMA: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Report {
    pub schema: u32,
    /// Lowercase UUID v4; also the `Idempotency-Key`.
    pub id: String,
    /// `YYYY-MM-DDTHH:MM:SSZ`.
    pub created_at: String,
    pub prompt: String,
    pub sdk: Sdk,
    pub app: App,
    pub device: Device,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locale: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot_omitted_reason: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sdk {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct App {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Ios,
    Macos,
    Web,
    Linux,
    Windows,
}

impl Platform {
    /// The platform this binary was built for (Linux for anything unknown).
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(target_os = "ios") {
            Self::Ios
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_family = "wasm") {
            Self::Web
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Device {
    pub platform: Platform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<Screen>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Screen {
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Context {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Why a report can't be sent as is.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Invalid {
    #[error("prompt is empty")]
    EmptyPrompt,
    #[error("prompt is longer than {0} characters")]
    PromptTooLong(usize),
    #[error("app id is empty")]
    NoAppId,
    #[error("extra has more than 32 keys, or a key over 64 / value over 1000 characters")]
    Extra,
}

impl Report {
    /// A new report with a fresh id and the current time.
    pub fn new(prompt: impl Into<String>, sdk: Sdk, app: App, device: Device) -> Self {
        Self {
            schema: SCHEMA,
            id: new_id(),
            created_at: now_rfc3339(),
            prompt: prompt.into(),
            sdk,
            app,
            device,
            locale: None,
            context: None,
            screenshot_omitted_reason: None,
            extra: BTreeMap::new(),
        }
    }

    pub fn validate(&self, limits: &Limits) -> Result<(), Invalid> {
        let n = self.prompt.chars().count();
        if self.prompt.trim().is_empty() {
            return Err(Invalid::EmptyPrompt);
        }
        if n > limits.max_prompt_chars {
            return Err(Invalid::PromptTooLong(limits.max_prompt_chars));
        }
        if self.app.id.is_empty() {
            return Err(Invalid::NoAppId);
        }
        if self.extra.len() > 32
            || self
                .extra
                .iter()
                .any(|(k, v)| k.chars().count() > 64 || v.chars().count() > 1000)
        {
            return Err(Invalid::Extra);
        }
        Ok(())
    }

    pub fn to_json(&self) -> Vec<u8> {
        // Serializing plain structs with string keys can't fail.
        serde_json::to_vec(self).unwrap_or_default()
    }

    /// Seconds since the Unix epoch of `created_at`, if it parses.
    pub fn created_unix(&self) -> Option<i64> {
        time::OffsetDateTime::parse(&self.created_at, &time::format_description::well_known::Rfc3339)
            .ok()
            .map(|t| t.unix_timestamp())
    }
}

/// A lowercase UUID v4.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now_rfc3339() -> String {
    format_unix(time::OffsetDateTime::now_utc().unix_timestamp())
}

/// `YYYY-MM-DDTHH:MM:SSZ` for a Unix timestamp.
pub fn format_unix(secs: i64) -> String {
    let t = time::OffsetDateTime::from_unix_timestamp(secs).unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    let f = time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]Z");
    t.format(&f).unwrap_or_default()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_have_whole_seconds() {
        assert_eq!(format_unix(1_793_890_688), "2026-11-05T14:58:08Z");
        let r = Report::new(
            "x",
            Sdk { name: "t".into(), version: "0".into() },
            App { id: "a".into(), ..App::default() },
            Device { platform: Platform::Linux, os_version: None, model: None, screen: None },
        );
        assert_eq!(r.created_at.len(), 20);
        assert!(r.created_unix().is_some());
        assert_eq!(r.id.len(), 36);
        assert_eq!(&r.id[14..15], "4");
    }

    #[test]
    fn validates_limits() {
        let mut r = Report::new(
            " ",
            Sdk { name: "t".into(), version: "0".into() },
            App { id: "a".into(), ..App::default() },
            Device { platform: Platform::Linux, os_version: None, model: None, screen: None },
        );
        let l = Limits::default();
        assert_eq!(r.validate(&l), Err(Invalid::EmptyPrompt));
        r.prompt = "é".repeat(4000);
        assert_eq!(r.validate(&l), Ok(()));
        r.prompt.push('x');
        assert_eq!(r.validate(&l), Err(Invalid::PromptTooLong(4000)));
    }
}
