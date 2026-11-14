//! The Worker's runner API (`spec/wire-format.md`, "Runner API").

use std::time::Duration;

use fixr_client::Report;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct Next {
    pub job: Job,
    pub project: Project,
    pub screenshot_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Job {
    pub id: String,
    pub report: Report,
    pub screenshot_mime: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Project {
    pub id: String,
    pub repo_path: String,
    pub base_branch: String,
    pub harness: String,
    pub permission: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Claimed,
    Running,
    Done,
    Blocked,
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct StatusUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<JobState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl StatusUpdate {
    pub fn state(state: JobState) -> Self {
        Self {
            state: Some(state),
            ..Self::default()
        }
    }

    pub fn detail(mut self, d: impl Into<String>) -> Self {
        self.detail = Some(d.into());
        self
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("worker answered {0}: {1}")]
    Status(u16, String),
}

#[derive(Debug, Clone)]
pub struct Api {
    base: String,
    token: String,
    http: reqwest::Client,
}

impl Api {
    pub fn new(base: &str, token: &str) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("fixr-runner/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            base: base.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            http,
        }
    }

    async fn check(resp: reqwest::Response) -> Result<reqwest::Response, ApiError> {
        let s = resp.status();
        if s.is_success() {
            Ok(resp)
        } else {
            let body = resp.text().await.unwrap_or_default();
            Err(ApiError::Status(
                s.as_u16(),
                body.chars().take(300).collect(),
            ))
        }
    }

    /// Long-polls for a job; `None` when there was none within `wait` seconds.
    pub async fn next(&self, wait: u64) -> Result<Option<Next>, ApiError> {
        let resp = self
            .http
            .get(format!("{}/v1/runner/next", self.base))
            .query(&[("wait", wait)])
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(wait + 15))
            .send()
            .await?;
        if resp.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(None);
        }
        Ok(Some(Self::check(resp).await?.json().await?))
    }

    pub async fn status(&self, job: &str, update: &StatusUpdate) -> Result<(), ApiError> {
        let resp = self
            .http
            .post(format!("{}/v1/runner/jobs/{job}/status", self.base))
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(30))
            .json(update)
            .send()
            .await?;
        Self::check(resp).await.map(drop)
    }

    pub async fn screenshot(&self, url: &str) -> Result<Vec<u8>, ApiError> {
        let resp = self
            .http
            .get(url)
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(60))
            .send()
            .await?;
        Ok(Self::check(resp).await?.bytes().await?.to_vec())
    }
}
