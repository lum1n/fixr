//! A real Claude Code session through acc against a throwaway repo.
//! `cargo test -p fixr-runner --features e2e -- --nocapture` (needs `claude`
//! logged in; costs one short session).
#![cfg(feature = "e2e")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::process::Command;

use acc_ssh::Host;
use fixr_runner::api::{Api, Next};
use fixr_runner::config::Config;
use fixr_runner::job;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn git(dir: &std::path::Path, args: &[&str]) {
    let ok = Command::new("git").current_dir(dir).args(args).status().unwrap().success();
    assert!(ok, "git {args:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_edits_a_worktree_and_reports_done() {
    let root = std::env::temp_dir().join(format!("fixr-e2e-{}", uuid::Uuid::new_v4()));
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README.md"), "# demo\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);

    let template = root.join("template.md");
    std::fs::write(
        &template,
        "Append the line `{{prompt}}` to README.md and commit it with message 'fixr e2e'. \
         Don't push, don't open a PR, do nothing else. Branch: {{branch}}.",
    )
    .unwrap();

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path_regex("^/v1/runner/jobs/.*/status$"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
        .mount(&server)
        .await;

    let mut report: fixr_client::Report =
        serde_json::from_str(include_str!("../../../spec/fixtures/report.v1.json")).unwrap();
    report.prompt = "hello from fixr".into();
    let next: Next = serde_json::from_value(serde_json::json!({
        "job": { "id": report.id, "report": report, "screenshot_mime": null },
        "project": { "id": "e2e", "repo_path": repo.to_str().unwrap(), "base_branch": "main",
                     "harness": "claude", "permission": "bypassPermissions", "model": null },
        "screenshot_url": null,
    }))
    .unwrap();
    let cfg: Config = toml::from_str(&format!(
        "worker_url = {:?}\nrunner_token = \"rt\"\nhook_token = \"ht\"\nsandbox = \"none\"\njob_timeout_minutes = 10\ntemplate = {:?}\n",
        server.uri(),
        template.to_str().unwrap()
    ))
    .unwrap();

    job::run(&Host::local(), &Api::new(&server.uri(), "rt"), &cfg, next).await;

    let bodies: Vec<serde_json::Value> = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|r| serde_json::from_slice(&r.body).unwrap())
        .collect();
    println!("status updates: {bodies:#?}");
    let session = bodies[0]["session_id"].as_str().expect("running with session id").to_owned();
    assert_eq!(bodies[0]["state"], "running");
    assert_eq!(bodies.last().unwrap()["state"], "done", "{bodies:?}");

    let home = dirs::home_dir().unwrap();
    assert!(home.join(".acc/s").join(&session).is_dir(), "session dir");
    let wt = home.join(".acc/w").join(&session);
    let readme = std::fs::read_to_string(wt.join("README.md")).unwrap();
    assert!(readme.contains("hello from fixr"), "{readme}");
    let log = Command::new("git").current_dir(&wt).args(["log", "--oneline", "-1"]).output().unwrap();
    println!("worktree head: {}", String::from_utf8_lossy(&log.stdout));

    // Clean up the worktree and branch.
    git(&repo, &["worktree", "remove", "--force", wt.to_str().unwrap()]);
    let _ = std::fs::remove_dir_all(&root);
}
