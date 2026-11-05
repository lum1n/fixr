#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::Duration;

use fixr_client::multipart::multipart;
use fixr_client::sender::attempt;
use fixr_client::*;
use serde_json::Value;

const GOLDEN: &str = include_str!("../../../spec/fixtures/report.v1.json");

/// Numbers compare by value (`2` == `2.0`).
fn normalize(v: Value) -> Value {
    match v {
        Value::Number(n) => serde_json::json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.into_iter().map(normalize).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, normalize(v))).collect()),
        v => v,
    }
}

fn golden_report() -> Report {
    let mut r = Report::new(
        "The Save button is misaligned with Cancel; make them the same height.",
        Sdk { name: "fixr-test".into(), version: "0.1.0".into() },
        App { id: "com.example.notes".into(), version: Some("1.4.2".into()), build: Some("231".into()) },
        Device {
            platform: Platform::Macos,
            os_version: Some("15.1".into()),
            model: Some("Mac15,6".into()),
            screen: Some(Screen { width: 1512, height: 982, scale: 2.0 }),
        },
    );
    r.id = "0b9f6c1e-3c1a-4d2b-9a57-5f3d2c1b0a99".into();
    r.created_at = "2026-11-05T14:03:12Z".into();
    r.locale = Some("en-US".into());
    r.context = Some(Context {
        screen: Some("EditorViewController".into()),
        title: Some("Untitled".into()),
        url: Some("https://notes.example.com/doc/42".into()),
    });
    r.screenshot_omitted_reason = Some("user_removed".into());
    r.extra.insert("branch".into(), "main".into());
    r.extra.insert("user_tier".into(), "beta".into());
    r
}

#[test]
fn serializes_like_the_golden_fixture() {
    let ours: Value = serde_json::from_slice(&golden_report().to_json()).unwrap();
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    assert_eq!(normalize(ours), normalize(golden));
    let back: Report = serde_json::from_str(GOLDEN).unwrap();
    assert_eq!(back, golden_report());
}

#[test]
fn omits_unknown_optionals() {
    let mut r = golden_report();
    r.locale = None;
    r.context = None;
    r.screenshot_omitted_reason = None;
    r.extra.clear();
    r.app.version = None;
    let v: Value = serde_json::from_slice(&r.to_json()).unwrap();
    let o = v.as_object().unwrap();
    for k in ["locale", "context", "screenshot_omitted_reason", "extra"] {
        assert!(!o.contains_key(k), "{k}");
    }
    assert!(!v["app"].as_object().unwrap().contains_key("version"));
}

#[test]
fn multipart_has_report_then_screenshot() {
    let img = Image { mime: "image/png".into(), bytes: b"\x89PNG fake".to_vec() };
    let b = multipart(&golden_report(), Some(&img), "XYZ");
    assert_eq!(b.content_type, "multipart/form-data; boundary=XYZ");
    let s = String::from_utf8_lossy(&b.bytes);
    let report_at = s.find("name=\"report\"").unwrap();
    let shot_at = s.find("name=\"screenshot\"; filename=\"screenshot.png\"").unwrap();
    assert!(report_at < shot_at);
    assert!(s.starts_with("--XYZ\r\n"));
    assert!(s.ends_with("--XYZ--\r\n"));
    assert!(s.contains("Content-Type: image/png\r\n\r\n\u{FFFD}PNG fake\r\n--XYZ--"));
}

#[test]
fn json_body_inlines_screenshot() {
    let img = Image { mime: "image/jpeg".into(), bytes: vec![0xff, 0xd8, 0xff] };
    let b = fixr_client::multipart::json(&golden_report(), Some(&img));
    let v: Value = serde_json::from_slice(&b.bytes).unwrap();
    assert_eq!(v["screenshot"]["mime"], "image/jpeg");
    assert_eq!(v["screenshot"]["data"], "/9j/");
}

/// Serves one canned response per connection and hands back what it got.
fn server(responses: Vec<&'static str>) -> (String, mpsc::Receiver<(String, Vec<u8>)>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for resp in responses {
            let (mut s, _) = l.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut head = String::new();
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
                head.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let mut body = vec![0; len];
            r.read_exact(&mut body).unwrap();
            s.write_all(resp.as_bytes()).unwrap();
            tx.send((head, body)).unwrap();
        }
    });
    (url, rx)
}

fn client(url: &str) -> Client {
    let mut c = ClientConfig::new(url, "secret", "fixr-test", "0.1.0");
    c.timeout = Duration::from_secs(5);
    Client::new(c)
}

#[test]
fn delivers_with_headers() {
    let (url, rx) = server(vec![
        "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
    ]);
    let r = golden_report();
    let out = client(&url).send(&r, Some(&Image { mime: "image/png".into(), bytes: vec![1] }));
    assert_eq!(out, Outcome::Delivered { duplicate: false });
    let (head, body) = rx.recv().unwrap();
    let h = head.to_ascii_lowercase();
    assert!(h.starts_with("post /v1/reports http/1.1"));
    assert!(h.contains("authorization: bearer secret"));
    assert!(h.contains(&format!("idempotency-key: {}", r.id)));
    assert!(h.contains("user-agent: fixr-test/0.1.0"));
    assert!(h.contains("content-type: multipart/form-data; boundary="));
    assert!(String::from_utf8_lossy(&body).contains("name=\"screenshot\""));
}

#[test]
fn queue_retries_then_delivers() {
    let (url, _rx) = server(vec![
        "HTTP/1.1 503 Unavailable\r\nRetry-After: 45\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    ]);
    let dir = std::env::temp_dir().join(format!("fixr-wire-{}", uuid::Uuid::new_v4()));
    let q = DiskQueue::new(&dir);
    let c = client(&url);
    let r = golden_report();
    q.enqueue(&r, None, 100).unwrap();
    let a = attempt(&c, &q, &r.id, 100);
    assert!(matches!(a, Attempt::Queued { next_attempt_at: 145, .. }), "{a:?}");
    assert_eq!(attempt(&c, &q, &r.id, 145), Attempt::Delivered);
    assert!(q.all().is_empty());
}

#[test]
fn permanent_failure_drops() {
    let (url, _rx) = server(vec![
        "HTTP/1.1 422 Unprocessable\r\nContent-Length: 17\r\nConnection: close\r\n\r\n{\"error\":\"nope\"}\n",
    ]);
    let dir = std::env::temp_dir().join(format!("fixr-wire-{}", uuid::Uuid::new_v4()));
    let q = DiskQueue::new(&dir);
    let r = golden_report();
    q.enqueue(&r, None, 0).unwrap();
    assert!(matches!(attempt(&client(&url), &q, &r.id, 0), Attempt::Dropped { .. }));
    assert!(q.all().is_empty());
}

#[test]
fn network_error_is_retryable() {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    drop(l);
    assert!(matches!(client(&url).send(&golden_report(), None), Outcome::RetryLater { .. }));
}
