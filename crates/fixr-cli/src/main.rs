//! `fixr "<prompt>" [--image shot.png]`: send a report to the fixr Worker.
//!
//! Exit codes: 0 delivered, 2 queued for retry (`fixr flush` later),
//! 3 dropped (the Worker refused it), 64 usage error.

use std::io::Write as _;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use fixr_client::sender::{attempt, flush_due, unix_now};
use fixr_client::*;

const SDK: &str = "fixr-cli";
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Parser, Debug)]
#[command(
    name = "fixr",
    version,
    about = "Send a UI fix request with a screenshot to a coding agent"
)]
#[command(args_conflicts_with_subcommands = true)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
    /// What to change.
    prompt: Option<String>,
    #[command(flatten)]
    send: SendArgs,
    #[command(flatten)]
    conn: Conn,
}

#[derive(clap::Args, Debug)]
struct Conn {
    /// Project key issued by `worker/scripts/add-project.ts`.
    #[arg(
        long = "project",
        env = "FIXR_PROJECT_KEY",
        global = true,
        hide_env_values = true
    )]
    project_key: Option<String>,
    /// Worker base URL.
    #[arg(long, env = "FIXR_ENDPOINT", global = true)]
    endpoint: Option<String>,
    /// App id in the report; also names the retry queue.
    #[arg(
        long = "app",
        env = "FIXR_APP_ID",
        default_value = "fixr-cli",
        global = true
    )]
    app_id: String,
    /// Retry queue directory (default: platform data dir).
    #[arg(long, global = true)]
    queue_dir: Option<PathBuf>,
}

#[derive(clap::Args, Debug)]
struct SendArgs {
    /// Screenshot (PNG/JPEG/any format `image` decodes); resized to the wire limits.
    #[arg(long)]
    image: Option<PathBuf>,
    /// Extra metadata, repeatable.
    #[arg(long = "meta", value_name = "KEY=VALUE", value_parser = parse_kv)]
    meta: Vec<(String, String)>,
    /// App version in the report.
    #[arg(long)]
    app_version: Option<String>,
    /// context.url / context.screen / context.title.
    #[arg(long)]
    url: Option<String>,
    #[arg(long)]
    screen: Option<String>,
    #[arg(long)]
    title: Option<String>,
    /// Send application/json instead of multipart.
    #[arg(long)]
    json: bool,
    /// Print the request instead of sending it.
    #[arg(long)]
    dry_run: bool,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Retry queued reports that are due.
    Flush {
        /// Retry every queued report now, not only due ones.
        #[arg(long)]
        all: bool,
    },
}

fn parse_kv(s: &str) -> Result<(String, String), String> {
    s.split_once('=')
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .ok_or_else(|| format!("expected KEY=VALUE, got {s:?}"))
}

const EX_USAGE: u8 = 64;

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(c) => c,
        Err(e) => {
            let code = if e.use_stderr() { EX_USAGE } else { 0 };
            let _ = e.print();
            return ExitCode::from(code);
        }
    };
    match run(cli) {
        Ok(code) => ExitCode::from(code),
        Err(msg) => {
            eprintln!("fixr: {msg}");
            ExitCode::from(EX_USAGE)
        }
    }
}

fn queue(conn: &Conn) -> DiskQueue {
    conn.queue_dir
        .clone()
        .map_or_else(|| DiskQueue::default_for(&conn.app_id), DiskQueue::new)
}

fn client(conn: &Conn, json: bool) -> Result<Client, String> {
    let endpoint = conn
        .endpoint
        .clone()
        .ok_or("--endpoint or FIXR_ENDPOINT is required")?;
    let key = conn
        .project_key
        .clone()
        .ok_or("--project or FIXR_PROJECT_KEY is required")?;
    let mut cfg = ClientConfig::new(endpoint, key, SDK, VERSION);
    if json {
        cfg.format = BodyFormat::Json;
    }
    Ok(Client::new(cfg))
}

fn run(cli: Cli) -> Result<u8, String> {
    if let Some(Cmd::Flush { all }) = cli.cmd {
        let c = client(&cli.conn, false)?;
        let q = queue(&cli.conn);
        let now = if all { i64::MAX } else { unix_now() };
        let results = flush_due(&c, &q, now);
        if results.is_empty() {
            eprintln!("fixr: nothing due in {}", q.dir().display());
        }
        let mut worst = 0;
        for (id, a) in results {
            worst = worst.max(report_attempt(&id, &a));
        }
        return Ok(worst);
    }

    let prompt = cli
        .prompt
        .ok_or("a prompt is required: fixr \"make the title bold\"")?;
    let a = cli.send;
    let limits = Limits::default();

    let mut report = Report::new(
        prompt,
        Sdk {
            name: SDK.into(),
            version: VERSION.into(),
        },
        App {
            id: cli.conn.app_id.clone(),
            version: a.app_version.clone(),
            build: None,
        },
        metadata::host_device_info(),
    );
    report.locale = metadata::host_locale();
    if a.url.is_some() || a.screen.is_some() || a.title.is_some() {
        report.context = Some(Context {
            screen: a.screen,
            title: a.title,
            url: a.url,
        });
    }
    report.extra = a.meta.into_iter().collect();

    let image = match &a.image {
        None => None,
        Some(path) => {
            let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
            match image::prepare_bytes(&bytes, &limits) {
                Ok(img) => Some(img),
                Err(PrepareError::TooLarge) => {
                    eprintln!("fixr: screenshot too large even after resizing; sending without it");
                    report.screenshot_omitted_reason = Some("too_large".into());
                    None
                }
                Err(e) => return Err(format!("{}: {e}", path.display())),
            }
        }
    };
    report.validate(&limits).map_err(|e| e.to_string())?;

    if a.dry_run {
        let format = if a.json {
            BodyFormat::Json
        } else {
            BodyFormat::Multipart
        };
        let body = multipart::body(&report, image.as_ref(), format);
        let url = cli.conn.endpoint.as_deref().map_or_else(
            || "<endpoint>/v1/reports".to_owned(),
            |e| ClientConfig::new(e, "", SDK, VERSION).reports_url(),
        );
        let mut out = std::io::stdout().lock();
        let _ = write!(
            out,
            "POST {url}\r\nAuthorization: Bearer <project key>\r\nIdempotency-Key: {}\r\nUser-Agent: {SDK}/{VERSION}\r\nContent-Type: {}\r\nContent-Length: {}\r\n\r\n",
            report.id,
            body.content_type,
            body.bytes.len()
        );
        let _ = out.write_all(&body.bytes);
        return Ok(0);
    }

    let c = client(&cli.conn, a.json)?;
    let q = queue(&cli.conn);
    q.enqueue(&report, image.as_ref(), unix_now())
        .map_err(|e| format!("queue {}: {e}", q.dir().display()))?;
    let result = attempt(&c, &q, &report.id, unix_now());
    Ok(report_attempt(&report.id, &result))
}

fn report_attempt(id: &str, a: &Attempt) -> u8 {
    match a {
        Attempt::Delivered => {
            println!("{id}");
            0
        }
        Attempt::Queued {
            next_attempt_at,
            reason,
        } => {
            let wait = next_attempt_at - unix_now();
            eprintln!("fixr: {id} queued ({reason}); retry in {wait}s with `fixr flush`");
            2
        }
        Attempt::Dropped { reason } => {
            eprintln!("fixr: {id} dropped: {reason}");
            3
        }
    }
}
