//! Fire and forget: `submit` writes the report to the disk queue and
//! returns; a background thread delivers it and retries on schedule.

use std::sync::mpsc::{self, RecvTimeoutError, Sender as Tx};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::queue::{AfterFailure, DiskQueue};
use crate::transport::{Client, Outcome};
use crate::{Image, Report};

pub fn unix_now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

/// What one attempt at a queued report did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attempt {
    Delivered,
    Queued { next_attempt_at: i64, reason: String },
    Dropped { reason: String },
}

/// Tries to deliver the queued report `id` once and updates the queue.
pub fn attempt(client: &Client, queue: &DiskQueue, id: &str, now: i64) -> Attempt {
    let Some(entry) = queue.get(id) else {
        return Attempt::Dropped { reason: "not in queue".into() };
    };
    match client.send(&entry.report, entry.image.as_ref()) {
        Outcome::Delivered { .. } => {
            let _ = queue.remove(id);
            Attempt::Delivered
        }
        Outcome::Dropped { reason, .. } => {
            let _ = queue.remove(id);
            Attempt::Dropped { reason }
        }
        Outcome::RetryLater { reason, retry_after } => match queue.record_failure(id, now, retry_after) {
            Ok(AfterFailure::RetryAt(t)) => Attempt::Queued { next_attempt_at: t, reason },
            Ok(AfterFailure::GaveUp) => Attempt::Dropped {
                reason: format!("gave up: {reason}"),
            },
            Err(e) => Attempt::Dropped {
                reason: format!("queue: {e}"),
            },
        },
    }
}

/// Attempts every due report once.
pub fn flush_due(client: &Client, queue: &DiskQueue, now: i64) -> Vec<(String, Attempt)> {
    queue
        .due(now)
        .into_iter()
        .map(|e| {
            let id = e.report.id;
            let a = attempt(client, queue, &id, now);
            (id, a)
        })
        .collect()
}

enum Msg {
    Wake,
    Stop,
}

/// The background delivery thread. Dropping it stops the thread after the
/// attempt in progress; undelivered reports stay on disk for next time.
#[derive(Debug)]
pub struct Sender {
    queue: DiskQueue,
    tx: Tx<Msg>,
    handle: Option<JoinHandle<()>>,
}

impl Sender {
    pub fn start(client: Client, queue: DiskQueue) -> Self {
        let (tx, rx) = mpsc::channel();
        let q = queue.clone();
        let handle = std::thread::Builder::new()
            .name("fixr-sender".into())
            .spawn(move || {
                loop {
                    let now = unix_now();
                    flush_due(&client, &q, now);
                    let wait = q
                        .next_due()
                        .map_or(3600, |t| (t - unix_now()).clamp(1, 3600));
                    match rx.recv_timeout(Duration::from_secs(wait as u64)) {
                        Ok(Msg::Wake) | Err(RecvTimeoutError::Timeout) => {}
                        Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
            })
            .ok();
        Self { queue, tx, handle }
    }

    /// Queues the report and returns; delivery happens in the background.
    pub fn submit(&self, report: &Report, image: Option<&Image>) -> std::io::Result<()> {
        self.queue.enqueue(report, image, unix_now())?;
        let _ = self.tx.send(Msg::Wake);
        Ok(())
    }

    /// Wakes the thread to retry now (on network change, app foreground...).
    /// Waiting reports keep their schedule; only due ones are attempted.
    pub fn flush(&self) {
        let _ = self.tx.send(Msg::Wake);
    }

    pub fn queue(&self) -> &DiskQueue {
        &self.queue
    }
}

impl Drop for Sender {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Stop);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}
