#![allow(clippy::unwrap_used)]

use fixr_runner::api::{Api, JobState, StatusUpdate};
use wiremock::matchers::{body_json, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const GOLDEN: &str = include_str!("../../../spec/fixtures/report.v1.json");

#[tokio::test]
async fn next_parses_a_job_and_204_is_none() {
    let server = MockServer::start().await;
    let report: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
    Mock::given(method("GET"))
        .and(path("/v1/runner/next"))
        .and(query_param("wait", "1"))
        .and(header("authorization", "Bearer rt"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "job": { "id": report["id"], "report": report, "screenshot_mime": "image/png", "created_at": report["created_at"] },
            "project": { "id": "notes", "repo_path": "~/repos/notes", "base_branch": "main",
                         "harness": "claude", "permission": "bypassPermissions", "model": null },
            "screenshot_url": format!("{}/v1/runner/jobs/x/screenshot?exp=1&sig=ab", server.uri()),
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/runner/next"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let api = Api::new(&server.uri(), "rt");
    let next = api.next(1).await.unwrap().unwrap();
    assert_eq!(next.job.report.prompt, "The Save button is misaligned with Cancel; make them the same height.");
    assert_eq!(next.project.harness, "claude");
    assert!(next.project.model.is_none());
    assert!(api.next(1).await.unwrap().is_none());
}

#[tokio::test]
async fn status_posts_only_set_fields() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/runner/jobs/J/status"))
        .and(body_json(serde_json::json!({ "state": "running", "session_id": "claude-abc" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "J", "state": "running"})))
        .expect(1)
        .mount(&server)
        .await;
    let api = Api::new(&server.uri(), "rt");
    let u = StatusUpdate {
        state: Some(JobState::Running),
        session_id: Some("claude-abc".into()),
        ..StatusUpdate::default()
    };
    api.status("J", &u).await.unwrap();
}

#[tokio::test]
async fn errors_carry_status() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(404).set_body_string("{\"error\":\"not_found\"}"))
        .mount(&server)
        .await;
    let api = Api::new(&server.uri(), "rt");
    let err = api.status("nope", &StatusUpdate::state(JobState::Done)).await.unwrap_err();
    assert!(err.to_string().contains("404"), "{err}");
}
