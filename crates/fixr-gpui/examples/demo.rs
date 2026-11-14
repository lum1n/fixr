//! A window with a deliberately misaligned button. Press cmd-shift-f (macOS)
//! or ctrl-shift-f, or click "Report a problem", to open the fixr overlay.
//!
//! ```sh
//! node spec/echo-server/server.mjs --port 8787      # in another terminal
//! RUST_LOG=fixr_gpui=debug cargo run -p fixr-gpui --example demo
//! ```
//!
//! `FIXR_ENDPOINT` (default `http://localhost:8787`) and `FIXR_PROJECT_KEY`
//! (default `demo-key`) override the target.

use std::collections::BTreeMap;
use std::sync::Arc;

use fixr_gpui::{Context as ReportContext, FixrConfig, Metadata};
use gpui::{
    App, Bounds, ClickEvent, Context, FocusHandle, Focusable, KeyBinding, Window, WindowBounds,
    WindowOptions, actions, div, prelude::*, px, rgb, size,
};

actions!(demo, [Quit]);

struct Demo {
    focus: FocusHandle,
}

impl Focusable for Demo {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn button(id: &'static str, label: &'static str) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .px_4()
        .py_2()
        .rounded_md()
        .bg(rgb(0x2563eb))
        .text_color(rgb(0xffffff))
        .cursor_pointer()
        .child(label)
}

impl Render for Demo {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let shortcut = if cfg!(target_os = "macos") {
            "Cmd-Shift-F"
        } else {
            "Ctrl-Shift-F"
        };
        div()
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .gap_6()
            .p_8()
            .bg(rgb(0xfafafa))
            .text_color(rgb(0x111827))
            .child(div().text_xl().child("Settings"))
            .child(div().child(format!(
                "The Save button below is misaligned on purpose. Press {shortcut} to report it."
            )))
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap_2()
                    .child(
                        div()
                            .id("cancel")
                            .px_4()
                            .py_2()
                            .rounded_md()
                            .border_1()
                            .border_color(rgb(0xd1d5db))
                            .child("Cancel"),
                    )
                    // The bug: an extra top margin and odd padding.
                    .child(button("save", "Save").mt(px(13.)).px(px(23.))),
            )
            .child(
                div()
                    .flex()
                    .child(button("report", "Report a problem").on_click(
                        |_: &ClickEvent, window, cx| {
                            fixr_gpui::open_report(window, cx);
                        },
                    )),
            )
    }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("fixr_gpui=info"))
        .init();
    let endpoint =
        std::env::var("FIXR_ENDPOINT").unwrap_or_else(|_| "http://localhost:8787".into());
    let project_key = std::env::var("FIXR_PROJECT_KEY").unwrap_or_else(|_| "demo-key".into());

    gpui_platform::application().run(move |cx: &mut App| {
        println!("fixr demo: reports go to {endpoint}");
        fixr_gpui::init(
            cx,
            FixrConfig {
                app_version: Some(env!("CARGO_PKG_VERSION").into()),
                metadata: Some(Arc::new(|_window: &Window, _cx: &App| Metadata {
                    build: Some("demo".into()),
                    context: ReportContext {
                        screen: Some("SettingsView".into()),
                        ..Default::default()
                    },
                    extra: BTreeMap::from([("example".to_owned(), "demo.rs".to_owned())]),
                })),
                ..FixrConfig::new(endpoint, project_key, "dev.fixr.gpui-demo")
            },
        );
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.bind_keys([KeyBinding::new(
            if cfg!(target_os = "macos") {
                "cmd-q"
            } else {
                "ctrl-q"
            },
            Quit,
            None,
        )]);

        let bounds = Bounds::centered(None, size(px(720.), px(480.)), cx);
        let opened = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |window, cx| {
                let view = cx.new(|cx| Demo {
                    focus: cx.focus_handle(),
                });
                window.focus(&view.focus_handle(cx), cx);
                view
            },
        );
        let Ok(main_window) = opened else {
            eprintln!("fixr demo: can't open a window");
            cx.quit();
            return;
        };
        let main_id = main_window.window_id();
        cx.on_window_closed(move |cx, id| {
            if id == main_id {
                cx.quit();
            }
        })
        .detach();
        cx.activate(true);
    });
}
