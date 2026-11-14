//! One job: worktree → detached agent session via acc → watch → PR lookup.

use std::collections::BTreeMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use acc_core::Harness;
use acc_core::command::Attachment;
use acc_core::sandbox::{Preset, Sandbox};
use acc_core::session::{LaunchRequest, Session, new_session_id};
use acc_core::shell::quote;
use acc_core::watch::{Hook, HostEvent, HostState, parse_events};
use acc_ssh::Host;
use tracing::{info, warn};

use crate::api::{Api, JobState, Next, StatusUpdate};
use crate::config::Config;
use crate::prompt;

/// How often the session's `events.ndjson` is read.
const POLL: Duration = Duration::from_secs(5);
/// Claude would stop at every tool use without this, and nobody is there to approve.
const DEFAULT_PERMISSION: &str = "bypassPermissions";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Keep watching.
    Running,
    /// Waiting on an approval or a question; reported once, then keep watching.
    Blocked(String),
    Done,
    Failed(String),
}

/// What the session's events so far mean for the job.
pub fn verdict(events: &[HostEvent]) -> Verdict {
    let mut v = Verdict::Running;
    for e in events {
        v = match e.state {
            HostState::Done => return Verdict::Done,
            HostState::Error => {
                return Verdict::Failed(e.detail.clone().unwrap_or_else(|| "agent error".into()));
            }
            HostState::Exited => {
                return Verdict::Failed(match e.code {
                    Some(c) => format!("agent exited with code {c} before finishing"),
                    None => "agent exited before finishing".into(),
                });
            }
            HostState::Blocked => {
                let kind = e
                    .kind
                    .and_then(|k| serde_json::to_value(k).ok())
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_else(|| "blocked".into());
                Verdict::Blocked(match &e.detail {
                    Some(d) => format!("{kind}: {d}"),
                    None => kind,
                })
            }
        };
    }
    v
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn harness(name: &str) -> Result<Harness, String> {
    let h: Harness = serde_json::from_value(serde_json::Value::String(name.to_owned()))
        .map_err(|_| format!("unknown harness {name:?}"))?;
    // Codex and ACP harnesses need the log followed until the session is up
    // before the first prompt goes in; not done yet.
    if !matches!(h, Harness::Claude | Harness::Pi) {
        return Err(format!(
            "harness {name:?} isn't supported by fixr-runner yet (claude, pi)"
        ));
    }
    Ok(h)
}

async fn sh(host: &Host, script: &str, stdin: &[u8]) -> Result<String, String> {
    let out = host.exec(script, stdin).await.map_err(|e| e.to_string())?;
    let out = out.ok().map_err(|e| e.to_string())?;
    Ok(out.stdout_str())
}

/// Runs a claimed job to the end, reporting to the Worker as it goes.
pub async fn run(host: &Host, api: &Api, cfg: &Config, next: Next) {
    let id = next.job.id.clone();
    if let Err(msg) = drive(host, api, cfg, next).await {
        warn!(job = %id, "failed: {msg}");
        if let Err(e) = api
            .status(&id, &StatusUpdate::state(JobState::Error).detail(msg))
            .await
        {
            warn!(job = %id, "couldn't report the error: {e}");
        }
    }
}

async fn drive(host: &Host, api: &Api, cfg: &Config, next: Next) -> Result<(), String> {
    let Next {
        job,
        project,
        screenshot_url,
    } = next;
    let harness = harness(&project.harness)?;

    let mut attachments = Vec::new();
    if let Some(url) = &screenshot_url {
        let bytes = api
            .screenshot(url)
            .await
            .map_err(|e| format!("screenshot: {e}"))?;
        image::load_from_memory(&bytes).map_err(|e| format!("screenshot doesn't decode: {e}"))?;
        if bytes.len() > Attachment::MAX_BYTES {
            return Err("screenshot over acc's 5 MiB attachment limit".into());
        }
        let mime = job
            .screenshot_mime
            .clone()
            .unwrap_or_else(|| "image/png".into());
        attachments.push(Attachment::from_bytes(mime, &bytes));
    }

    let session_id = new_session_id(harness, uuid::Uuid::new_v4().as_bytes());
    let branch = acc_core::worktree::branch(&session_id);

    // Start from the remote's base branch when there is one, so PRs aren't
    // based on a stale local checkout.
    let base = sh(
        host,
        &base_script(&project.repo_path, &project.base_branch),
        b"",
    )
    .await
    .map_err(|e| format!("{}: {e}", project.repo_path))?;
    let base = base.trim();
    let cwd = sh(
        host,
        &acc_core::worktree::add_script(&project.repo_path, &session_id, Some(base)),
        b"",
    )
    .await
    .map_err(|e| format!("worktree: {e}"))?;
    let cwd = cwd.lines().last().unwrap_or_default().trim().to_owned();
    if cwd.is_empty() {
        return Err("worktree script printed no directory".into());
    }

    let template = match &cfg.template {
        Some(p) => std::fs::read_to_string(p).map_err(|e| format!("{}: {e}", p.display()))?,
        None => prompt::DEFAULT_TEMPLATE.to_owned(),
    };
    let text = prompt::render(
        &template,
        &prompt::Vars {
            report: &job.report,
            job_id: &job.id,
            branch: &branch,
            base_branch: &project.base_branch,
            has_screenshot: !attachments.is_empty(),
        },
    );

    let labels = BTreeMap::from([
        ("source".to_owned(), "fixr".to_owned()),
        ("job".to_owned(), job.id.clone()),
        ("project".to_owned(), project.id.clone()),
    ]);
    let req = LaunchRequest {
        harness: Some(harness),
        cwd: cwd.clone(),
        model: project.model.clone(),
        permission: Some(
            project
                .permission
                .clone()
                .unwrap_or_else(|| DEFAULT_PERMISSION.into()),
        ),
        title: Some(prompt::title(&job.report)),
        prompt: Some(text),
        attachments,
        labels,
        worktree: Some(session_id.clone()),
        sandbox: (cfg.sandbox == "workspace").then(|| Sandbox {
            preset: Preset::Workspace,
            // `gh` and `git push` need their credentials.
            show_credentials: true,
            ..Sandbox::default()
        }),
        ..LaunchRequest::default()
    };
    let (mut session, launch) =
        Session::launch(req, &session_id, "fixr", now_ms()).map_err(|e| e.to_string())?;

    // Before launching, so the Worker can map webhook events to the job.
    api.status(
        &job.id,
        &StatusUpdate {
            state: Some(JobState::Running),
            session_id: Some(session_id.clone()),
            detail: Some(format!("worktree {cwd}")),
            ..StatusUpdate::default()
        },
    )
    .await
    .map_err(|e| format!("status: {e}"))?;

    let pid = sh(host, &launch.script, &launch.stdin)
        .await
        .map_err(|e| format!("launch: {e}"))?;
    for u in session.on_launched(&pid) {
        info!(job = %job.id, "{:?}", u.event);
    }
    let transmit = session.take_transmit();
    let input = session.input_exec(transmit);
    sh(host, &input.script, &input.stdin)
        .await
        .map_err(|e| format!("prompt: {e}"))?;
    let watch = session.watch_exec(Some(&Hook::Webhook {
        url: cfg.hook_url(),
    }));
    sh(host, &watch.script, &watch.stdin)
        .await
        .map_err(|e| format!("watch: {e}"))?;
    info!(job = %job.id, session = %session_id, %cwd, "agent started");

    let deadline = Instant::now() + Duration::from_secs(cfg.job_timeout_minutes * 60);
    let mut offset = 0u64;
    let mut events = Vec::new();
    let mut reported_block: Option<String> = None;
    let outcome = loop {
        tokio::time::sleep(POLL).await;
        if Instant::now() > deadline {
            break Verdict::Failed(format!(
                "timed out after {} minutes",
                cfg.job_timeout_minutes
            ));
        }
        let e = session.events_exec(offset);
        let text = match sh(host, &e.script, &e.stdin).await {
            Ok(t) => t,
            Err(err) => {
                warn!(job = %job.id, "events: {err}");
                continue;
            }
        };
        // Only whole lines; a partial last line is read again next time.
        let complete = text.rfind('\n').map_or(0, |i| i + 1);
        offset += complete as u64;
        events.extend(parse_events(&text[..complete]));
        match verdict(&events) {
            Verdict::Running => {}
            Verdict::Blocked(d) => {
                if reported_block.as_ref() != Some(&d) {
                    let _ = api
                        .status(
                            &job.id,
                            &StatusUpdate::state(JobState::Blocked).detail(d.clone()),
                        )
                        .await;
                    reported_block = Some(d);
                }
            }
            v => break v,
        }
    };

    let result = match outcome {
        Verdict::Done => {
            let pr = sh(host, &pr_script(&cwd, &branch), b"")
                .await
                .unwrap_or_default();
            let pr = pr.trim();
            let update = if pr.starts_with("http") {
                info!(job = %job.id, "PR {pr}");
                StatusUpdate {
                    pr_url: Some(pr.to_owned()),
                    ..StatusUpdate::state(JobState::Done)
                }
            } else {
                StatusUpdate::state(JobState::Done).detail(format!("no PR found for {branch}"))
            };
            api.status(&job.id, &update)
                .await
                .map_err(|e| format!("status: {e}"))
        }
        Verdict::Failed(msg) => Err(msg),
        Verdict::Running | Verdict::Blocked(_) => Ok(()),
    };

    if cfg.stop_when_done || result.is_err() {
        let k = session.kill_exec();
        let _ = sh(host, &k.script, &k.stdin).await;
    }
    result
}

/// Prints `origin/<base>` after fetching it, or `<base>` without a remote.
fn base_script(repo: &str, base: &str) -> String {
    let dir = match repo.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"/{}", quote(rest)),
        None => quote(repo),
    };
    let remote = quote(&format!("origin/{base}^{{commit}}"));
    format!(
        "cd {dir} || exit 1\n\
         git fetch -q origin {b} >/dev/null 2>&1\n\
         if git rev-parse -q --verify {remote} >/dev/null; then echo {ob}; else echo {b}; fi\n",
        b = quote(base),
        ob = quote(&format!("origin/{base}")),
    )
}

fn pr_script(cwd: &str, branch: &str) -> String {
    format!(
        "cd {} || exit 1\ngh pr list --head {} --state all --json url --jq '.[0].url // empty'\n",
        quote(cwd),
        quote(branch)
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn ev(json: &str) -> HostEvent {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn verdicts() {
        assert_eq!(verdict(&[]), Verdict::Running);
        let blocked = ev(
            r#"{"at":1,"session":"s","state":"blocked","kind":"permission","detail":"Bash","offset":1}"#,
        );
        assert_eq!(
            verdict(std::slice::from_ref(&blocked)),
            Verdict::Blocked("permission: Bash".into())
        );
        let done = ev(r#"{"at":2,"session":"s","state":"done","offset":2}"#);
        assert_eq!(verdict(&[blocked.clone(), done.clone()]), Verdict::Done);
        let exited = ev(r#"{"at":3,"session":"s","state":"exited","code":1,"offset":3}"#);
        // Done wins over the exit that follows our own kill.
        assert_eq!(verdict(&[done, exited.clone()]), Verdict::Done);
        assert_eq!(
            verdict(&[exited]),
            Verdict::Failed("agent exited with code 1 before finishing".into())
        );
        let err =
            ev(r#"{"at":4,"session":"s","state":"error","detail":"rate limited","offset":4}"#);
        assert_eq!(verdict(&[err]), Verdict::Failed("rate limited".into()));
    }

    #[test]
    fn harness_support() {
        assert_eq!(harness("claude"), Ok(Harness::Claude));
        assert!(harness("codex").is_err());
        assert!(harness("nope").is_err());
    }

    #[test]
    fn scripts_quote_paths() {
        let s = base_script("~/repos/my app", "main");
        assert!(
            s.starts_with("cd \"$HOME\"/'my app'") || s.starts_with("cd \"$HOME\"/'repos/my app'"),
            "{s}"
        );
        assert!(s.contains("origin/main"));
        let p = pr_script("/tmp/x y", "acc/claude-1");
        assert!(p.contains("'/tmp/x y'"));
        assert!(p.contains("--head acc/claude-1") || p.contains("--head 'acc/claude-1'"));
    }
}
