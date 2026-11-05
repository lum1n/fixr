//! `~/.config/fixr/runner.toml`.

use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Worker base URL, e.g. `https://fixr.example.workers.dev`.
    pub worker_url: String,
    pub runner_token: String,
    /// Secret in the acc webhook URL (`HOOK_TOKEN` on the Worker).
    pub hook_token: String,
    #[serde(default = "default_parallel")]
    pub max_parallel: usize,
    /// Long-poll length, seconds (the Worker caps it at 25).
    #[serde(default = "default_wait")]
    pub poll_wait: u64,
    /// Give a job this long before stopping its agent.
    #[serde(default = "default_timeout")]
    pub job_timeout_minutes: u64,
    /// Confine agents with acc's sandbox (`workspace`) or not (`none`).
    #[serde(default = "default_sandbox")]
    pub sandbox: String,
    /// Stop the agent once its turn is done (the session stays on disk for `acc` to resume).
    #[serde(default = "default_true")]
    pub stop_when_done: bool,
    /// Prompt template overriding the built-in one.
    #[serde(default)]
    pub template: Option<PathBuf>,
}

fn default_parallel() -> usize {
    2
}
fn default_wait() -> u64 {
    25
}
fn default_timeout() -> u64 {
    120
}
fn default_sandbox() -> String {
    "workspace".into()
}
fn default_true() -> bool {
    true
}

impl Config {
    pub fn default_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("fixr")
            .join("runner.toml")
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut c: Self = toml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        c.worker_url = c.worker_url.trim_end_matches('/').to_owned();
        if c.max_parallel == 0 {
            c.max_parallel = 1;
        }
        if !matches!(c.sandbox.as_str(), "workspace" | "none") {
            return Err(format!("sandbox must be \"workspace\" or \"none\", not {:?}", c.sandbox));
        }
        Ok(c)
    }

    pub fn hook_url(&self) -> String {
        format!("{}/v1/hooks/acc?token={}", self.worker_url, self.hook_token)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn parses_with_defaults() {
        let c: Config = toml::from_str(
            "worker_url = \"https://w.dev/\"\nrunner_token = \"r\"\nhook_token = \"h\"\n",
        )
        .unwrap();
        assert_eq!(c.max_parallel, 2);
        assert_eq!(c.sandbox, "workspace");
        assert!(c.stop_when_done);
    }
}
