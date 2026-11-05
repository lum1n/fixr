//! What the host machine says about itself, best effort.

use crate::report::{Device, Platform};

pub fn host_device_info() -> Device {
    Device {
        platform: Platform::current(),
        os_version: os_version(),
        model: model(),
        screen: None,
    }
}

/// `LANG=nb_NO.UTF-8` → `nb-NO`.
pub fn host_locale() -> Option<String> {
    let raw = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty() && v != "C" && v != "POSIX"))?;
    let tag = raw.split(['.', '@']).next()?.replace('_', "-");
    (!tag.is_empty()).then_some(tag)
}

fn trimmed(s: String) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.chars().take(200).collect())
}

fn command(program: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(program).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
        .and_then(trimmed)
}

fn os_version() -> Option<String> {
    if cfg!(target_os = "macos") {
        return command("sw_vers", &["-productVersion"]);
    }
    if cfg!(target_os = "linux") {
        let pretty = std::fs::read_to_string("/etc/os-release").ok().and_then(|s| {
            s.lines()
                .find_map(|l| l.strip_prefix("PRETTY_NAME=").map(|v| v.trim_matches('"').to_owned()))
        });
        let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease").ok().and_then(trimmed);
        return match (pretty, kernel) {
            (Some(p), Some(k)) => Some(format!("{p} ({k})")),
            (p, k) => p.or(k),
        };
    }
    None
}

fn model() -> Option<String> {
    if cfg!(target_os = "macos") {
        return command("sysctl", &["-n", "hw.model"]);
    }
    if cfg!(target_os = "linux") {
        // Boards without real DMI data report placeholders.
        const PLACEHOLDERS: [&str; 4] = ["System Product Name", "To be filled by O.E.M.", "Default string", "None"];
        return std::fs::read_to_string("/sys/devices/virtual/dmi/id/product_name")
            .ok()
            .and_then(trimmed)
            .filter(|m| !PLACEHOLDERS.contains(&m.as_str()));
    }
    None
}
