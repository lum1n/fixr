# fixr-gpui

fixr for [gpui](https://gpui.rs) apps. The user presses a hotkey, the window
they're looking at is captured, and a small overlay lets them black out private
areas and say what should change. Send hands the report to a background sender
and closes the overlay at once. Delivery and retries run off the UI thread and
persist on disk (`fixr-client`'s `Sender` + `DiskQueue`).

Built against **`gpui-pre = "=0.3.11"`** (lib name `gpui`, a snapshot of
zed@f816e1f). gpui changes often, so the version is pinned exactly. Each
capture backend lives in its own file so a gpui bump touches as little as
possible.

## Use

```rust
use fixr_gpui::{FixrConfig, Metadata};

fixr_gpui::init(cx, FixrConfig {
    app_version: Some(env!("CARGO_PKG_VERSION").into()),
    // Optional: called on OpenReport with the window being reported.
    metadata: Some(std::sync::Arc::new(|_window, _cx| Metadata {
        build: Some("231".into()),
        ..Default::default()
    })),
    ..FixrConfig::new("https://fixr.example.workers.dev", project_key, "com.example.app")
});
```

`FixrConfig` fields: `endpoint`, `project_key`, `app_id`, `app_version`,
`metadata`, `capture: CaptureStrategy` (`Auto` | `Disabled` |
`Custom(Arc<dyn WindowCapturer>)`), `limits` (`fixr_client::Limits`, the
wire-format defaults), `bind_open_shortcut` (default `true`).

`init` binds these keys (`default_key_bindings()` returns them). With
`bind_open_shortcut: false` it leaves out the `OpenReport` key, for apps where
that key is taken and the overlay opens from a menu or command palette instead
(`key_bindings(false)` returns that set):

| keys                                  | action                 | where             |
|---------------------------------------|------------------------|-------------------|
| `cmd-shift-f` (macOS) / `ctrl-shift-f` | `fixr::OpenReport`     | anywhere          |
| `escape`                              | `fixr::CancelReport`   | overlay           |
| `cmd/ctrl-enter`                      | `fixr::SendReport`     | overlay           |
| `cmd/ctrl-shift-r`                    | `fixr::ToggleRedact`   | overlay           |

The overlay's key context is `FixrOverlay`, and its prompt field's is
`FixrTextArea`. Call `fixr_gpui::open_report(window, cx)` to open the
overlay from your own button or menu.

Reports carry `sdk.name = "fixr-gpui"` and `sdk.version` from the crate
version. The device comes from `fixr_client::metadata`, `device.screen` from
the window's display (points plus scale), and `context.title` is the window
title unless your metadata provider supplies one.

## Capture

Capture runs on `OpenReport`, before the overlay window exists, so the overlay
is never in the picture.

| feature               | default     | what                                                                      |
|-----------------------|-------------|---------------------------------------------------------------------------|
| `capture-macos`       | yes (macOS) | `CGWindowListCreateImage` on our own window number (raw-window-handle AppKit NSView → NSWindow → `windowNumber`). Composited pixels. Your own windows don't need Screen Recording permission. |
| `capture-x11`         | yes (Linux) | x11rb `GetImage` on our own X11 window id, over a separate connection, then xRGB → RGBA. |
| `capture-portal`      | no          | ashpd xdg-desktop-portal Screenshot, for Wayland. Interactive: the desktop shows its own dialog, and the result is the screen or whatever the user picks, not just our window. The portal's temporary file is deleted after it's read. |
| `capture-gpui-render` | no          | gpui `Window::render_to_image` (turns on `gpui/test-support`). In gpui-pre 0.3.11 only the macOS and Windows windows implement it. On Linux it always fails with `capture_failed`. |

`CaptureStrategy::Auto` picks a backend from the window's raw handle. AppKit
uses macOS capture and X11 uses x11rb. Wayland uses the portal if that
feature is on. Otherwise the report goes out without a screenshot and with
`screenshot_omitted_reason: "wayland_unsupported"`, because a Wayland client
can't read its own composited pixels. Other `screenshot_omitted_reason`
values this crate sends: `capture_failed`, `capture_disabled`, `user_removed`
("Remove screenshot" in the overlay), `too_large` (`prepare_rgba` gave up),
and `capture_unsupported` (no backend compiled in for this window system).

## Overlay

A separate 640×520 window holds:

- the capture preview,
- black redaction boxes you drag to draw (on by default, toggled with
  `ToggleRedact`, "Undo box" removes the last one),
- a minimal multiline prompt field,
- Cancel and Send.

When you send, each box is scaled from preview to image pixels and burned
into the full-resolution capture. The capture then goes through
`fixr_client::image::prepare_rgba` and `Sender::submit` on a background
thread, so nothing un-redacted leaves the process.

The prompt field is modelled on gpui's `examples/input.rs`: the same
`EntityInputHandler`, so IME and dead keys work. It adds soft-wrapped
paragraphs, Enter for newline, Up/Down, and scrolling to keep the cursor in
view. The `gpui-component` `Input` swap the plan mentions is not implemented.

The window kind is `WindowKind::PopUp` on macOS and Wayland. On X11 it is
`WindowKind::Floating` instead, because gpui makes X11 pop-ups
override-redirect, and the window manager never gives those keyboard focus.

## Demo

```sh
node spec/echo-server/server.mjs --port 8787          # writes out/<id>.{json,png}
cargo run -p fixr-gpui --example demo                 # FIXR_ENDPOINT, FIXR_PROJECT_KEY override
```

The demo is a window with a deliberately misaligned Save button. Press
ctrl/cmd-shift-f (or click "Report a problem"), draw a box, type, and press
ctrl/cmd-enter.

## Status

- Linux/X11: built, unit-tested, and run end to end under Xvfb. The steps
  were: hotkey, capture, overlay, drag a redaction, multiline typing and
  selection, Send. The echo server received a PNG with the box burned in. Esc
  cancels.
- **macOS: not compiled for real.** `src/capture/macos.rs` is behind
  `cfg(target_os = "macos")` and was written without a Mac. It has been
  type-checked against the real `objc2-app-kit` / `objc2-core-graphics` 0.3.2
  APIs, but only on Linux with gpui stubbed out and the framework link
  attributes removed. Build and try it on a Mac before relying on it.
- Wayland portal capture compiles but hasn't been run.
- Windows: no native capturer. Use `capture-gpui-render` or
  `CaptureStrategy::Custom`.
