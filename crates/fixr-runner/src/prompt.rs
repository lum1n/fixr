//! Turns a report into the agent's first prompt.

use fixr_client::Report;

pub const DEFAULT_TEMPLATE: &str = include_str!("../templates/report.md");

pub struct Vars<'a> {
    pub report: &'a Report,
    pub job_id: &'a str,
    pub branch: &'a str,
    pub base_branch: &'a str,
    pub has_screenshot: bool,
}

pub fn render(template: &str, v: &Vars<'_>) -> String {
    let shot = if v.has_screenshot {
        "The attached image is a screenshot of the app at the moment they filed it (areas they blacked out are redacted)."
            .to_owned()
    } else {
        match v.report.screenshot_omitted_reason.as_deref() {
            Some(r) => format!("No screenshot came with the report ({r})."),
            None => "No screenshot came with the report.".to_owned(),
        }
    };
    template
        .replace("{{prompt}}", v.report.prompt.trim())
        .replace("{{screenshot_note}}", &shot)
        .replace("{{metadata}}", &metadata(v.report))
        .replace("{{branch}}", v.branch)
        .replace("{{base_branch}}", v.base_branch)
        .replace("{{job_id}}", v.job_id)
}

fn metadata(r: &Report) -> String {
    let mut lines = Vec::new();
    let mut push = |k: &str, v: Option<&str>| {
        if let Some(v) = v.filter(|v| !v.is_empty()) {
            lines.push(format!("- {k}: {v}"));
        }
    };
    let app = match (&r.app.version, &r.app.build) {
        (Some(v), Some(b)) => format!("{} {v} ({b})", r.app.id),
        (Some(v), None) => format!("{} {v}", r.app.id),
        _ => r.app.id.clone(),
    };
    push("App", Some(&app));
    let platform = serde_json::to_value(r.device.platform)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let os = match &r.device.os_version {
        Some(os) => format!("{platform} {os}"),
        None => platform,
    };
    push("Platform", Some(&os));
    push("Device", r.device.model.as_deref());
    let screen = r
        .device
        .screen
        .map(|s| format!("{}×{} points @{}x", s.width, s.height, s.scale));
    push("Screen", screen.as_deref());
    push("Locale", r.locale.as_deref());
    if let Some(c) = &r.context {
        push("View", c.screen.as_deref());
        push("Window title", c.title.as_deref());
        push("URL", c.url.as_deref());
    }
    for (k, v) in &r.extra {
        push(k, Some(v));
    }
    push("Reported at", Some(&r.created_at));
    push("SDK", Some(&format!("{} {}", r.sdk.name, r.sdk.version)));
    lines.join("\n")
}

/// The session title: the prompt's first line, shortened.
pub fn title(r: &Report) -> String {
    let first = r.prompt.trim().lines().next().unwrap_or_default();
    let mut t: String = first.chars().take(60).collect();
    if first.chars().count() > 60 {
        t.push('…');
    }
    format!("fixr: {t}")
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn golden() -> Report {
        serde_json::from_str(include_str!("../../../spec/fixtures/report.v1.json")).unwrap()
    }

    #[test]
    fn renders_everything() {
        let r = golden();
        let out = render(
            DEFAULT_TEMPLATE,
            &Vars {
                report: &r,
                job_id: "J1",
                branch: "acc/claude-x",
                base_branch: "main",
                has_screenshot: true,
            },
        );
        assert!(!out.contains("{{"), "{out}");
        assert!(out.contains("The Save button is misaligned"));
        assert!(out.contains("- App: com.example.notes 1.4.2 (231)"));
        assert!(out.contains("- Platform: macos 15.1"));
        assert!(out.contains("- Screen: 1512×982 points @2x"));
        assert!(out.contains("- URL: https://notes.example.com/doc/42"));
        assert!(out.contains("- branch: main"));
        assert!(out.contains("gh pr create --base main --head acc/claude-x"));
        assert!(out.contains("fixr report `J1`"));
        assert!(out.contains("attached image"));
    }

    #[test]
    fn notes_missing_screenshot() {
        let r = golden();
        let out = render(
            "{{screenshot_note}}",
            &Vars {
                report: &r,
                job_id: "J",
                branch: "b",
                base_branch: "m",
                has_screenshot: false,
            },
        );
        assert_eq!(out, "No screenshot came with the report (user_removed).");
    }

    #[test]
    fn title_is_short() {
        let mut r = golden();
        r.prompt = "x".repeat(100);
        assert_eq!(title(&r).chars().count(), "fixr: ".len() + 61);
    }
}
