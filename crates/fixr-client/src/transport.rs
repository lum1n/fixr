//! One blocking POST /v1/reports and what to do about its answer.

use std::time::Duration;

use crate::multipart::{BodyFormat, body};
use crate::{Image, Report};

/// What a delivery attempt means for the queued report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// 201, or 200 for a report the Worker already had.
    Delivered { duplicate: bool },
    /// 408, 429, 5xx or a network error. `retry_after` from the header.
    RetryLater { reason: String, retry_after: Option<Duration> },
    /// Any other 4xx: the report will never be accepted.
    Dropped { status: u16, reason: String },
}

/// Maps a status to an outcome, per `spec/wire-format.md`.
pub fn classify(status: u16, body: &str, retry_after: Option<Duration>) -> Outcome {
    match status {
        200 => Outcome::Delivered { duplicate: true },
        201 | 202 | 204 => Outcome::Delivered { duplicate: false },
        408 | 429 | 500..=599 => Outcome::RetryLater {
            reason: format!("HTTP {status}"),
            retry_after,
        },
        s if (200..300).contains(&s) => Outcome::Delivered { duplicate: false },
        s => Outcome::Dropped {
            status: s,
            reason: format!("HTTP {s}: {}", body.chars().take(300).collect::<String>()),
        },
    }
}

#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// Base URL of the Worker, e.g. `https://fixr.example.workers.dev`.
    /// `/v1/reports` is appended unless the URL already ends with it.
    pub endpoint: String,
    pub project_key: String,
    /// `fixr-<sdk>/<semver>`.
    pub user_agent: String,
    pub format: BodyFormat,
    pub timeout: Duration,
}

impl ClientConfig {
    pub fn new(endpoint: impl Into<String>, project_key: impl Into<String>, sdk: &str, version: &str) -> Self {
        Self {
            endpoint: endpoint.into(),
            project_key: project_key.into(),
            user_agent: format!("{sdk}/{version}"),
            format: BodyFormat::Multipart,
            timeout: Duration::from_secs(60),
        }
    }

    pub fn reports_url(&self) -> String {
        let base = self.endpoint.trim_end_matches('/');
        if base.ends_with("/v1/reports") {
            base.to_owned()
        } else {
            format!("{base}/v1/reports")
        }
    }
}

#[derive(Debug, Clone)]
pub struct Client {
    config: ClientConfig,
    agent: ureq::Agent,
}

impl Client {
    pub fn new(config: ClientConfig) -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(config.timeout))
            .user_agent(config.user_agent.as_str())
            .build()
            .into();
        Self { config, agent }
    }

    pub fn config(&self) -> &ClientConfig {
        &self.config
    }

    pub fn send(&self, report: &Report, image: Option<&Image>) -> Outcome {
        let b = body(report, image, self.config.format);
        let res = self
            .agent
            .post(&self.config.reports_url())
            .header("Authorization", &format!("Bearer {}", self.config.project_key))
            .header("Idempotency-Key", &report.id)
            .header("Content-Type", &b.content_type)
            .send(&b.bytes[..]);
        match res {
            Ok(mut resp) => {
                let status = resp.status().as_u16();
                let retry_after = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.trim().parse::<u64>().ok())
                    .map(Duration::from_secs);
                let text = resp.body_mut().read_to_string().unwrap_or_default();
                classify(status, &text, retry_after)
            }
            Err(e) => Outcome::RetryLater {
                reason: e.to_string(),
                retry_after: None,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_statuses() {
        assert_eq!(classify(201, "", None), Outcome::Delivered { duplicate: false });
        assert_eq!(classify(200, "", None), Outcome::Delivered { duplicate: true });
        for s in [408, 429, 500, 503] {
            assert!(matches!(classify(s, "", None), Outcome::RetryLater { .. }), "{s}");
        }
        for s in [400, 401, 403, 404, 413, 422] {
            assert!(matches!(classify(s, "", None), Outcome::Dropped { .. }), "{s}");
        }
    }

    #[test]
    fn url_is_normalized() {
        let c = ClientConfig::new("https://x.dev/", "k", "fixr-test", "0");
        assert_eq!(c.reports_url(), "https://x.dev/v1/reports");
        let c = ClientConfig::new("http://localhost:8787/v1/reports", "k", "fixr-test", "0");
        assert_eq!(c.reports_url(), "http://localhost:8787/v1/reports");
    }
}
