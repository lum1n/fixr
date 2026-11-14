//! Reports waiting for delivery, on disk: `<dir>/<id>/{report.json,
//! screenshot.png|jpg, state.json}`. `state.json` is written last, so an
//! entry without it is a half-written one and is ignored.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::{Image, Report};

/// Give up after this many failed attempts...
pub const MAX_ATTEMPTS: u32 = 20;
/// ...or this long after the report was made.
pub const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);

/// Delay after the `failures`-th failed attempt (1-based): 30 s, 2 min,
/// 10 min, 1 h, 6 h, then daily.
pub fn backoff(failures: u32) -> Duration {
    const TABLE: [u64; 5] = [30, 120, 600, 3600, 21_600];
    let i = failures.saturating_sub(1) as usize;
    Duration::from_secs(TABLE.get(i).copied().unwrap_or(86_400))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    pub attempts: u32,
    /// Unix seconds.
    pub next_attempt_at: i64,
    /// Unix seconds; from `created_at`, or the enqueue time when it doesn't parse.
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub report: Report,
    pub image: Option<Image>,
    pub state: State,
}

/// What happened to an entry after a failed attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterFailure {
    RetryAt(i64),
    GaveUp,
}

#[derive(Debug, Clone)]
pub struct DiskQueue {
    dir: PathBuf,
}

impl DiskQueue {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// `~/.local/share/fixr/queue/<app>` (platform data dir).
    pub fn default_for(app_id: &str) -> Self {
        let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
        let safe: String = app_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        Self::new(base.join("fixr").join("queue").join(safe))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn entry_dir(&self, id: &str) -> Option<PathBuf> {
        // Ids are UUIDs; refuse anything that could escape the directory.
        (!id.is_empty() && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
            .then(|| self.dir.join(id))
    }

    /// Stores a report, due immediately. Re-enqueueing the same id keeps its state.
    pub fn enqueue(&self, report: &Report, image: Option<&Image>, now: i64) -> io::Result<()> {
        let dir = self
            .entry_dir(&report.id)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bad report id"))?;
        if dir.join("state.json").exists() {
            return Ok(());
        }
        fs::create_dir_all(&dir)?;
        write_atomic(&dir.join("report.json"), &report.to_json())?;
        if let Some(img) = image {
            write_atomic(
                &dir.join(format!("screenshot.{}", img.extension())),
                &img.bytes,
            )?;
        }
        let state = State {
            attempts: 0,
            next_attempt_at: now,
            created_at: report.created_unix().unwrap_or(now),
        };
        self.write_state(&dir, &state)
    }

    fn write_state(&self, dir: &Path, state: &State) -> io::Result<()> {
        write_atomic(
            &dir.join("state.json"),
            &serde_json::to_vec(state).unwrap_or_default(),
        )
    }

    pub fn get(&self, id: &str) -> Option<Entry> {
        let dir = self.entry_dir(id)?;
        let state: State = serde_json::from_slice(&fs::read(dir.join("state.json")).ok()?).ok()?;
        let report: Report =
            serde_json::from_slice(&fs::read(dir.join("report.json")).ok()?).ok()?;
        let image = [("png", "image/png"), ("jpg", "image/jpeg")]
            .iter()
            .find_map(|(ext, mime)| {
                fs::read(dir.join(format!("screenshot.{ext}")))
                    .ok()
                    .map(|bytes| Image {
                        mime: (*mime).into(),
                        bytes,
                    })
            });
        Some(Entry {
            report,
            image,
            state,
        })
    }

    /// Every complete entry, oldest first.
    pub fn all(&self) -> Vec<Entry> {
        let Ok(rd) = fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut out: Vec<Entry> = rd
            .filter_map(Result::ok)
            .filter_map(|e| e.file_name().to_str().and_then(|id| self.get(id)))
            .collect();
        out.sort_by_key(|e| (e.state.created_at, e.report.id.clone()));
        out
    }

    pub fn due(&self, now: i64) -> Vec<Entry> {
        self.all()
            .into_iter()
            .filter(|e| e.state.next_attempt_at <= now)
            .collect()
    }

    /// When the next entry is due, if any.
    pub fn next_due(&self) -> Option<i64> {
        self.all().iter().map(|e| e.state.next_attempt_at).min()
    }

    pub fn remove(&self, id: &str) -> io::Result<()> {
        match self.entry_dir(id) {
            Some(dir) if dir.exists() => fs::remove_dir_all(dir),
            _ => Ok(()),
        }
    }

    /// Records a failed attempt; drops the entry when it ran out of attempts or time.
    pub fn record_failure(
        &self,
        id: &str,
        now: i64,
        retry_after: Option<Duration>,
    ) -> io::Result<AfterFailure> {
        let Some(mut entry) = self.get(id) else {
            return Ok(AfterFailure::GaveUp);
        };
        entry.state.attempts += 1;
        let age = now - entry.state.created_at;
        if entry.state.attempts >= MAX_ATTEMPTS || age >= MAX_AGE.as_secs() as i64 {
            self.remove(id)?;
            return Ok(AfterFailure::GaveUp);
        }
        let delay = backoff(entry.state.attempts).max(retry_after.unwrap_or_default());
        entry.state.next_attempt_at = now + delay.as_secs() as i64;
        let dir = self.dir.join(id);
        self.write_state(&dir, &entry.state)?;
        Ok(AfterFailure::RetryAt(entry.state.next_attempt_at))
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::report::*;

    fn report() -> Report {
        Report::new(
            "fix it",
            Sdk {
                name: "t".into(),
                version: "0".into(),
            },
            App {
                id: "a".into(),
                ..App::default()
            },
            Device {
                platform: Platform::Linux,
                os_version: None,
                model: None,
                screen: None,
            },
        )
    }

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("fixr-queue-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn backoff_table() {
        let secs: Vec<u64> = (1..=8).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(secs, [30, 120, 600, 3600, 21_600, 86_400, 86_400, 86_400]);
    }

    #[test]
    fn enqueue_due_fail_remove() {
        let q = DiskQueue::new(tmp());
        let mut r = report();
        r.created_at = format_unix(1_000_000);
        let img = Image {
            mime: "image/png".into(),
            bytes: vec![1, 2, 3],
        };
        q.enqueue(&r, Some(&img), 1_000_000).unwrap();
        let due = q.due(1_000_000);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].image.as_ref().unwrap().bytes, vec![1, 2, 3]);
        assert_eq!(due[0].report, r);

        assert_eq!(
            q.record_failure(&r.id, 1_000_000, None).unwrap(),
            AfterFailure::RetryAt(1_000_030)
        );
        assert!(q.due(1_000_029).is_empty());
        assert_eq!(q.due(1_000_030).len(), 1);
        // Retry-After longer than the table wins.
        assert_eq!(
            q.record_failure(&r.id, 1_000_030, Some(Duration::from_secs(500)))
                .unwrap(),
            AfterFailure::RetryAt(1_000_530)
        );
        q.remove(&r.id).unwrap();
        assert!(q.all().is_empty());
    }

    #[test]
    fn gives_up_after_max_attempts_or_age() {
        let q = DiskQueue::new(tmp());
        let mut r = report();
        r.created_at = format_unix(0);
        q.enqueue(&r, None, 0).unwrap();
        let mut now = 0;
        for _ in 0..MAX_ATTEMPTS - 1 {
            assert!(matches!(
                q.record_failure(&r.id, now, None).unwrap(),
                AfterFailure::RetryAt(_)
            ));
            now += 1;
        }
        assert_eq!(
            q.record_failure(&r.id, now, None).unwrap(),
            AfterFailure::GaveUp
        );
        assert!(q.get(&r.id).is_none());

        let r2 = report();
        let created = r2.created_unix().unwrap();
        q.enqueue(&r2, None, created).unwrap();
        let week = MAX_AGE.as_secs() as i64;
        assert_eq!(
            q.record_failure(&r2.id, created + week, None).unwrap(),
            AfterFailure::GaveUp
        );
    }

    #[test]
    fn ignores_half_written_entries_and_bad_ids() {
        let d = tmp();
        fs::create_dir_all(d.join("0b9f6c1e-3c1a-4d2b-9a57-5f3d2c1b0a99")).unwrap();
        let q = DiskQueue::new(d);
        assert!(q.all().is_empty());
        assert!(q.get("../etc").is_none());
    }
}
