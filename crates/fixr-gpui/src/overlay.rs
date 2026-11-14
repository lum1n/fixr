//! The report overlay: a separate small window with the capture, redaction
//! boxes, a prompt field and Send/Cancel.

use std::sync::Arc;

use fixr_client::image::{PrepareError, prepare_rgba};
use fixr_client::{Image, Limits, Report};
use gpui::{
    App, Bounds, ClickEvent, Context, CursorStyle, DisplayId, Entity, FocusHandle, Focusable,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point, RenderImage,
    SharedString, Stateful, TitlebarOptions, Window, WindowBounds, WindowKind, WindowOptions,
    canvas, div, img, prelude::*, px, rgb, size,
};
use image::RgbaImage;

use crate::capture::{CaptureError, WindowSystem, reason, window_system};
use crate::pixels::swap_red_blue;
use crate::redact::{Redaction, burn_in, fit_preview};
use crate::report::{Snapshot, build_report};
use crate::text_area::TextArea;
use crate::{CancelReport, Fixr, OVERLAY_CONTEXT, SendReport, ToggleRedact};

const WINDOW_SIZE: (f32, f32) = (640.0, 520.0);
const PREVIEW_BOX: (f32, f32) = (608.0, 268.0);

/// What the overlay needs to know about the window being reported.
#[derive(Debug, Clone)]
pub(crate) struct Parent {
    display: Option<DisplayId>,
    scale: f32,
    kind: WindowKind,
}

impl Parent {
    pub fn of(window: &Window, cx: &App) -> Self {
        // On X11 gpui makes PopUp windows override-redirect, which the window
        // manager never gives keyboard focus, so the prompt couldn't be typed
        // into. A Floating window is transient-for its parent instead.
        let kind = match window_system(window) {
            WindowSystem::X11 => WindowKind::Floating,
            _ => WindowKind::PopUp,
        };
        Self {
            display: window.display(cx).map(|d| d.id()),
            scale: window.scale_factor(),
            kind,
        }
    }
}

struct Shot {
    /// Full-resolution capture, RGBA. Taken on send.
    pixels: Option<RgbaImage>,
    /// Downscaled BGRA copy for the GPU.
    preview: Arc<RenderImage>,
    /// Logical size the preview is drawn at; redactions are in this space.
    preview_size: (f32, f32),
}

impl Shot {
    fn new(pixels: RgbaImage, scale: f32) -> Self {
        let preview_size = fit_preview(pixels.dimensions(), PREVIEW_BOX, scale);
        let pw = ((preview_size.0 * scale).round() as u32).max(1);
        let ph = ((preview_size.1 * scale).round() as u32).max(1);
        let mut small = if (pw, ph) == pixels.dimensions() {
            pixels.clone()
        } else {
            image::imageops::resize(&pixels, pw, ph, image::imageops::FilterType::Triangle)
        };
        swap_red_blue(&mut small);
        let preview = Arc::new(RenderImage::new(vec![image::Frame::new(small)]));
        Self {
            pixels: Some(pixels),
            preview,
            preview_size,
        }
    }
}

pub(crate) struct Overlay {
    focus: FocusHandle,
    input: Entity<TextArea>,
    snapshot: Snapshot,
    shot: Option<Shot>,
    /// Why there is no screenshot, when there isn't one.
    omitted: Option<&'static str>,
    include_shot: bool,
    redact_mode: bool,
    redactions: Vec<Redaction>,
    drag: Option<((f32, f32), (f32, f32))>,
    /// Window coordinates of the preview's top-left corner, from the last paint.
    preview_origin: Option<Point<Pixels>>,
    error: Option<SharedString>,
}

/// Opens the overlay window with the capture result. Called after capture.
pub(crate) fn open(
    result: Result<RgbaImage, CaptureError>,
    snapshot: Snapshot,
    parent: Parent,
    cx: &mut App,
) {
    let (shot, omitted) = match result {
        Ok(pixels) => (Some(Shot::new(pixels, parent.scale)), None),
        Err(e) => {
            log::info!("fixr: no screenshot: {e}");
            (None, Some(e.omitted_reason()))
        }
    };
    let bounds = Bounds::centered(
        parent.display,
        size(px(WINDOW_SIZE.0), px(WINDOW_SIZE.1)),
        cx,
    );
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        titlebar: Some(TitlebarOptions {
            title: Some("Report a problem".into()),
            ..Default::default()
        }),
        kind: parent.kind,
        focus: true,
        show: true,
        is_resizable: false,
        is_minimizable: false,
        display_id: parent.display,
        ..Default::default()
    };
    let opened = cx.open_window(options, |window, cx| {
        let input = cx.new(|cx| {
            TextArea::new(
                "What should change? e.g. \"The Save button is misaligned\"",
                cx,
            )
        });
        window.focus(&input.focus_handle(cx), cx);
        cx.new(|cx| Overlay {
            focus: cx.focus_handle(),
            input,
            snapshot,
            shot,
            omitted,
            include_shot: true,
            redact_mode: true,
            redactions: Vec::new(),
            drag: None,
            preview_origin: None,
            error: None,
        })
    });
    match opened {
        Ok(handle) => {
            if cx.has_global::<Fixr>() {
                cx.global_mut::<Fixr>().overlay = Some(handle.into());
            }
            let _ = handle.update(cx, |_, window, _| window.activate_window());
        }
        Err(e) => log::warn!("fixr: can't open the overlay window: {e:#}"),
    }
}

impl Overlay {
    fn local(&self, position: Point<Pixels>) -> Option<(f32, f32)> {
        let origin = self.preview_origin?;
        let (w, h) = self.shot.as_ref()?.preview_size;
        let x = f32::from(position.x - origin.x).clamp(0.0, w);
        let y = f32::from(position.y - origin.y).clamp(0.0, h);
        Some((x, y))
    }

    fn on_preview_down(&mut self, event: &MouseDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if !self.redact_mode || !self.include_shot {
            return;
        }
        if let Some(p) = self.local(event.position) {
            self.drag = Some((p, p));
            cx.notify();
        }
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.drag.is_none() {
            return;
        }
        if let (Some(p), Some((_, end))) = (self.local(event.position), self.drag.as_mut()) {
            *end = p;
            cx.notify();
        }
    }

    fn on_mouse_up(&mut self, event: &MouseUpEvent, window: &mut Window, cx: &mut Context<Self>) {
        let Some((start, mut end)) = self.drag.take() else {
            return;
        };
        if let Some(p) = self.local(event.position) {
            end = p;
        }
        let r = Redaction::from_corners(start, end);
        if r.is_meaningful() {
            self.redactions.push(r);
        }
        // Clicking the preview took focus away from the prompt; give it back.
        window.focus(&self.input.focus_handle(cx), cx);
        cx.notify();
    }

    fn toggle_redact(&mut self, _: &ToggleRedact, _: &mut Window, cx: &mut Context<Self>) {
        self.redact_mode = !self.redact_mode;
        cx.notify();
    }

    fn cancel(&mut self, _: &CancelReport, window: &mut Window, cx: &mut Context<Self>) {
        self.close(window, cx);
    }

    fn send(&mut self, _: &SendReport, window: &mut Window, cx: &mut Context<Self>) {
        let Some(state) = cx.try_global::<Fixr>() else {
            log::warn!("fixr: SendReport before fixr_gpui::init");
            return;
        };
        let limits = state.config.limits;
        let prompt = self.input.read(cx).text().to_owned();
        let n = prompt.trim().chars().count();
        if n == 0 {
            self.error = Some("Describe what's wrong first.".into());
            cx.notify();
            return;
        }
        if n > limits.max_prompt_chars {
            self.error =
                Some(format!("Too long: {n} of {} characters.", limits.max_prompt_chars).into());
            cx.notify();
            return;
        }
        let image = match (&mut self.shot, self.include_shot) {
            (Some(shot), true) => shot.pixels.take().map(|p| (p, shot.preview_size)),
            _ => None,
        };
        let omitted = match (&self.shot, self.include_shot) {
            (Some(_), false) => Some(reason::USER_REMOVED),
            (Some(_), true) => None,
            (None, _) => self.omitted.or(Some(reason::CAPTURE_FAILED)),
        };
        let report = build_report(&state.config, &self.snapshot, &prompt, omitted);
        let redactions = std::mem::take(&mut self.redactions);
        let sender = state.sender.clone();

        // Fire and forget: resize/encode and enqueue off the UI thread.
        let spawned = std::thread::Builder::new()
            .name("fixr-submit".into())
            .spawn(move || {
                let (report, image) = finish(report, image, &redactions, &limits);
                if let Err(e) = report.validate(&limits) {
                    log::warn!("fixr: report dropped, invalid: {e}");
                    return;
                }
                if let Err(e) = sender.submit(&report, image.as_ref()) {
                    log::warn!("fixr: can't queue report {}: {e}", report.id);
                }
            });
        if let Err(e) = spawned {
            log::warn!("fixr: can't start submit thread: {e}");
        }
        self.close(window, cx);
    }

    fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(shot) = self.shot.take() {
            let _ = window.drop_image(shot.preview);
        }
        if cx.has_global::<Fixr>() {
            cx.global_mut::<Fixr>().overlay = None;
        }
        window.remove_window();
    }

    fn render_preview(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let Some(shot) = &self.shot else {
            let why = self.omitted.unwrap_or(reason::CAPTURE_FAILED);
            return div()
                .text_color(rgb(0xbbbbbb))
                .child(format!(
                    "No screenshot ({why}). The report will be sent without one."
                ))
                .into_any_element();
        };
        if !self.include_shot {
            return div()
                .text_color(rgb(0xbbbbbb))
                .child("Screenshot removed. The report will be sent without one.")
                .into_any_element();
        }
        let (w, h) = shot.preview_size;
        let view = cx.entity();
        let boxes = self.redactions.iter().map(|r| redaction_box(r, 1.0));
        let dragging = self
            .drag
            .map(|(a, b)| redaction_box(&Redaction::from_corners(a, b), 0.6));
        div()
            .relative()
            .w(px(w))
            .h(px(h))
            .when(self.redact_mode, |d| d.cursor(CursorStyle::Crosshair))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_preview_down))
            .child(img(shot.preview.clone()).size_full())
            .children(boxes)
            .children(dragging)
            .child(
                canvas(
                    move |bounds, _, cx| {
                        view.update(cx, |this, _| this.preview_origin = Some(bounds.origin))
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            .into_any_element()
    }
}

fn redaction_box(r: &Redaction, opacity: f32) -> gpui::Div {
    div()
        .absolute()
        .left(px(r.x0))
        .top(px(r.y0))
        .w(px(r.width()))
        .h(px(r.height()))
        .bg(gpui::black())
        .opacity(opacity)
}

fn button(id: &'static str, label: impl Into<SharedString>, primary: bool) -> Stateful<gpui::Div> {
    let (bg, fg, hover) = if primary {
        (rgb(0x2563eb), rgb(0xffffff), rgb(0x1d4ed8))
    } else {
        (rgb(0xffffff), rgb(0x1f2937), rgb(0xe5e7eb))
    };
    div()
        .id(id)
        .px_3()
        .py_1()
        .rounded_md()
        .border_1()
        .border_color(rgb(0xd1d5db))
        .bg(bg)
        .text_color(fg)
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .child(label.into())
}

/// Burns the redactions into the capture, then resizes/encodes it per the
/// wire-format ladder. Too-large images are dropped with `too_large`.
pub(crate) fn finish(
    mut report: Report,
    image: Option<(RgbaImage, (f32, f32))>,
    redactions: &[Redaction],
    limits: &Limits,
) -> (Report, Option<Image>) {
    let Some((mut pixels, preview_size)) = image else {
        return (report, None);
    };
    burn_in(&mut pixels, redactions, preview_size);
    match prepare_rgba(pixels, limits) {
        Ok(img) => {
            report.screenshot_omitted_reason = None;
            (report, Some(img))
        }
        Err(e) => {
            log::warn!("fixr: screenshot not attached: {e}");
            report.screenshot_omitted_reason = Some(
                match e {
                    PrepareError::TooLarge => reason::TOO_LARGE,
                    PrepareError::Decode(_) => reason::CAPTURE_FAILED,
                }
                .into(),
            );
            (report, None)
        }
    }
}

impl Focusable for Overlay {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Overlay {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let input_focused = self.input.focus_handle(cx).is_focused(window);
        let has_shot = self.shot.is_some();
        let max = cx
            .try_global::<Fixr>()
            .map_or(4000, |s| s.config.limits.max_prompt_chars);
        let count = self.input.read(cx).text().trim().chars().count();
        let status: SharedString = match &self.error {
            Some(e) => e.clone(),
            None => format!("{count} / {max}").into(),
        };
        let status_color = if self.error.is_some() || count > max {
            rgb(0xdc2626)
        } else {
            rgb(0x6b7280)
        };
        let hint = if !has_shot || !self.include_shot {
            ""
        } else if self.redact_mode {
            "Drag on the screenshot to black out private areas."
        } else {
            "Redaction is off."
        };

        div()
            .key_context(OVERLAY_CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::send))
            .on_action(cx.listener(Self::cancel))
            .on_action(cx.listener(Self::toggle_redact))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .size_full()
            .flex()
            .flex_col()
            .gap_3()
            .p_4()
            .bg(rgb(0xf3f4f6))
            .text_color(rgb(0x111827))
            .text_sm()
            .child(
                div()
                    .flex()
                    .justify_between()
                    .child(
                        div()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child("Report a problem"),
                    )
                    .child(div().text_color(rgb(0x6b7280)).child(hint)),
            )
            .child(
                div()
                    .h(px(PREVIEW_BOX.1))
                    .w_full()
                    .flex()
                    .justify_center()
                    .items_center()
                    .rounded_md()
                    .bg(rgb(0x1f2937))
                    .overflow_hidden()
                    .child(self.render_preview(cx)),
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .when(has_shot && self.include_shot, |row| {
                        row.child(
                            button(
                                "redact",
                                if self.redact_mode {
                                    "Redact: on"
                                } else {
                                    "Redact: off"
                                },
                                false,
                            )
                            .on_click(cx.listener(
                                |this, _: &ClickEvent, window, cx| {
                                    this.toggle_redact(&ToggleRedact, window, cx)
                                },
                            )),
                        )
                        .when(!self.redactions.is_empty(), |row| {
                            row.child(button("undo", "Undo box", false).on_click(cx.listener(
                                |this, _: &ClickEvent, _, cx| {
                                    this.redactions.pop();
                                    cx.notify();
                                },
                            )))
                        })
                    })
                    .when(has_shot, |row| {
                        row.child(
                            button(
                                "include",
                                if self.include_shot {
                                    "Remove screenshot"
                                } else {
                                    "Include screenshot"
                                },
                                false,
                            )
                            .on_click(cx.listener(
                                |this, _: &ClickEvent, _, cx| {
                                    this.include_shot = !this.include_shot;
                                    this.drag = None;
                                    cx.notify();
                                },
                            )),
                        )
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .w_full()
                    .p_2()
                    .rounded_md()
                    .bg(rgb(0xffffff))
                    .border_1()
                    .border_color(if input_focused {
                        rgb(0x2563eb)
                    } else {
                        rgb(0xd1d5db)
                    })
                    .overflow_hidden()
                    .child(self.input.clone()),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_color(status_color).child(status))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(button("cancel", "Cancel", false).on_click(cx.listener(
                                |this, _: &ClickEvent, window, cx| {
                                    this.cancel(&CancelReport, window, cx)
                                },
                            )))
                            .child(button("send", "Send", true).on_click(cx.listener(
                                |this, _: &ClickEvent, window, cx| {
                                    this.send(&SendReport, window, cx)
                                },
                            ))),
                    ),
            )
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use fixr_client::{App as AppInfo, Device, Platform, Sdk};
    use image::Rgba;

    use super::*;

    fn report() -> Report {
        Report::new(
            "x",
            Sdk {
                name: "fixr-gpui".into(),
                version: "0".into(),
            },
            AppInfo {
                id: "a".into(),
                ..AppInfo::default()
            },
            Device {
                platform: Platform::Linux,
                os_version: None,
                model: None,
                screen: None,
            },
        )
    }

    #[test]
    fn redactions_are_burned_in_before_encoding() {
        let pixels = RgbaImage::from_pixel(400, 200, Rgba([255, 255, 255, 255]));
        // Preview at 200×100 (half size); box (10,10)-(50,30) → pixels (20,20)-(100,60).
        let r = Redaction::from_corners((10.0, 10.0), (50.0, 30.0));
        let (report, img) = finish(
            report(),
            Some((pixels, (200.0, 100.0))),
            &[r],
            &Limits::default(),
        );
        assert_eq!(report.screenshot_omitted_reason, None);
        let img = img.unwrap();
        assert_eq!(img.mime, "image/png");
        let decoded = image::load_from_memory(&img.bytes).unwrap().to_rgba8();
        assert_eq!(decoded.dimensions(), (400, 200));
        assert_eq!(decoded.get_pixel(20, 20).0, [0, 0, 0, 255]);
        assert_eq!(decoded.get_pixel(99, 59).0, [0, 0, 0, 255]);
        assert_eq!(decoded.get_pixel(100, 60).0, [255, 255, 255, 255]);
        assert_eq!(decoded.get_pixel(19, 20).0, [255, 255, 255, 255]);
    }

    #[test]
    fn oversized_capture_is_dropped_as_too_large() {
        let mut x: u32 = 0x9e37_79b9;
        let noise = RgbaImage::from_fn(300, 300, |_, _| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            Rgba([x as u8, (x >> 8) as u8, (x >> 16) as u8, 255])
        });
        let limits = Limits {
            max_image_bytes: 100,
            ..Limits::default()
        };
        let (report, img) = finish(report(), Some((noise, (300.0, 300.0))), &[], &limits);
        assert!(img.is_none());
        assert_eq!(
            report.screenshot_omitted_reason.as_deref(),
            Some("too_large")
        );
    }

    #[test]
    fn no_image_keeps_the_reason() {
        let mut r = report();
        r.screenshot_omitted_reason = Some("wayland_unsupported".into());
        let (r, img) = finish(r, None, &[], &Limits::default());
        assert!(img.is_none());
        assert_eq!(
            r.screenshot_omitted_reason.as_deref(),
            Some("wayland_unsupported")
        );
    }
}
