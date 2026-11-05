//! Shared Rust core for fixr clients (CLI, gpui) and the runner's types.
//!
//! - [`Report`]: the document from `spec/report.schema.json`.
//! - [`image::prepare`]: the resize/encode ladder.
//! - [`Client::send`]: one POST, classified into an [`Outcome`].
//! - [`DiskQueue`] + [`Sender`]: fire and forget with retries on disk.

pub mod image;
pub mod metadata;
pub mod multipart;
pub mod queue;
pub mod report;
pub mod sender;
pub mod transport;

pub use crate::image::{Image, PrepareError};
pub use crate::multipart::{Body, BodyFormat};
pub use crate::queue::DiskQueue;
pub use crate::report::{App, Context, Device, Platform, Report, Screen, Sdk};
pub use crate::sender::{Attempt, Sender};
pub use crate::transport::{Client, ClientConfig, Outcome};

/// Limits from `spec/wire-format.md`, identical on every client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_prompt_chars: usize,
    pub max_image_dimension: u32,
    pub max_image_bytes: usize,
    pub max_body_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_prompt_chars: 4000,
            max_image_dimension: 2000,
            max_image_bytes: 2_000_000,
            max_body_bytes: 2_621_440,
        }
    }
}
