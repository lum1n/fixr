//! `fixr-runner [--config PATH]`: long-polls the fixr Worker for reports and
//! starts a coding agent for each through acc on this machine.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use acc_ssh::Host;
use fixr_runner::api::Api;
use fixr_runner::config::Config;
use fixr_runner::job;
use tokio::sync::Semaphore;
use tracing::{error, info, warn};

#[tokio::main]
async fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "fixr_runner=info".into()),
        )
        .init();

    let mut args = std::env::args().skip(1);
    let mut path = Config::default_path();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--config" => match args.next() {
                Some(p) => path = PathBuf::from(p),
                None => return usage("--config needs a path"),
            },
            "-h" | "--help" => {
                println!("usage: fixr-runner [--config PATH]   (default {})", Config::default_path().display());
                return std::process::ExitCode::SUCCESS;
            }
            other => return usage(&format!("unknown argument {other:?}")),
        }
    }
    let cfg = match Config::load(&path) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            error!("{e}");
            return std::process::ExitCode::from(78);
        }
    };

    let api = Arc::new(Api::new(&cfg.worker_url, &cfg.runner_token));
    let host = Arc::new(Host::local());
    let slots = Arc::new(Semaphore::new(cfg.max_parallel));
    info!(worker = %cfg.worker_url, max_parallel = cfg.max_parallel, "fixr-runner started");

    let poll = async {
        let mut backoff = Duration::from_secs(1);
        loop {
            // Only claim a job when there is room to run it.
            let Ok(permit) = slots.clone().acquire_owned().await else { return };
            match api.next(cfg.poll_wait).await {
                Ok(Some(next)) => {
                    backoff = Duration::from_secs(1);
                    info!(job = %next.job.id, project = %next.project.id, "claimed");
                    let (host, api, cfg) = (host.clone(), api.clone(), cfg.clone());
                    tokio::spawn(async move {
                        job::run(&host, &api, &cfg, next).await;
                        drop(permit);
                    });
                }
                Ok(None) => backoff = Duration::from_secs(1),
                Err(e) => {
                    warn!("poll: {e}; retrying in {}s", backoff.as_secs());
                    drop(permit);
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(60));
                }
            }
        }
    };
    tokio::select! {
        () = poll => {}
        _ = tokio::signal::ctrl_c() => info!("stopping; running agents keep going detached"),
    }
    std::process::ExitCode::SUCCESS
}

fn usage(msg: &str) -> std::process::ExitCode {
    eprintln!("fixr-runner: {msg}");
    std::process::ExitCode::from(64)
}
