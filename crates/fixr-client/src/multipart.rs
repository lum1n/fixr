//! Request bodies: `multipart/form-data` (default) or `application/json`.

use base64::Engine as _;

use crate::{Image, Report};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum BodyFormat {
    #[default]
    Multipart,
    Json,
}

/// A ready-to-send body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Body {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub fn body(report: &Report, image: Option<&Image>, format: BodyFormat) -> Body {
    match format {
        BodyFormat::Multipart => multipart(report, image, &boundary()),
        BodyFormat::Json => json(report, image),
    }
}

fn boundary() -> String {
    format!("fixr-{}", uuid::Uuid::new_v4().simple())
}

pub fn multipart(report: &Report, image: Option<&Image>, boundary: &str) -> Body {
    let mut b = Vec::new();
    b.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    b.extend_from_slice(b"Content-Disposition: form-data; name=\"report\"\r\n");
    b.extend_from_slice(b"Content-Type: application/json\r\n\r\n");
    b.extend_from_slice(&report.to_json());
    b.extend_from_slice(b"\r\n");
    if let Some(img) = image {
        b.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        b.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"screenshot\"; filename=\"screenshot.{}\"\r\n",
                img.extension()
            )
            .as_bytes(),
        );
        b.extend_from_slice(format!("Content-Type: {}\r\n\r\n", img.mime).as_bytes());
        b.extend_from_slice(&img.bytes);
        b.extend_from_slice(b"\r\n");
    }
    b.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Body {
        content_type: format!("multipart/form-data; boundary={boundary}"),
        bytes: b,
    }
}

pub fn json(report: &Report, image: Option<&Image>) -> Body {
    let mut v = serde_json::to_value(report).unwrap_or_default();
    if let (Some(img), Some(obj)) = (image, v.as_object_mut()) {
        obj.insert(
            "screenshot".into(),
            serde_json::json!({
                "mime": img.mime,
                "data": base64::engine::general_purpose::STANDARD.encode(&img.bytes),
            }),
        );
    }
    Body {
        content_type: "application/json".into(),
        bytes: serde_json::to_vec(&v).unwrap_or_default(),
    }
}
