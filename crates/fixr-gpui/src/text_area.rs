//! A minimal multiline text input, modelled on gpui's `examples/input.rs`
//! (same `EntityInputHandler` plumbing, so IME and dead keys work) but with
//! soft-wrapped paragraphs via `shape_text`, Enter for newlines, Up/Down and
//! vertical scrolling to keep the cursor in view.

use std::ops::Range;

use gpui::{
    App, Bounds, ClipboardItem, ContentMask, Context, CursorStyle, ElementId, ElementInputHandler, Entity,
    EntityInputHandler, FocusHandle, Focusable, GlobalElementId, KeyBinding, LayoutId, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point, SharedString, Style, TextRun, UTF16Selection, Window,
    WrappedLine, actions, div, fill, hsla, point, prelude::*, px, relative, rgba, size,
};
use unicode_segmentation::UnicodeSegmentation as _;

pub(crate) const CONTEXT: &str = "FixrTextArea";

actions!(
    fixr_text_area,
    [
        Backspace,
        Delete,
        Left,
        Right,
        Up,
        Down,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        SelectAll,
        Home,
        End,
        Newline,
        Paste,
        Cut,
        Copy,
    ]
);

pub(crate) fn key_bindings() -> Vec<KeyBinding> {
    let ctx = Some(CONTEXT);
    vec![
        KeyBinding::new("backspace", Backspace, ctx),
        KeyBinding::new("delete", Delete, ctx),
        KeyBinding::new("left", Left, ctx),
        KeyBinding::new("right", Right, ctx),
        KeyBinding::new("up", Up, ctx),
        KeyBinding::new("down", Down, ctx),
        KeyBinding::new("shift-left", SelectLeft, ctx),
        KeyBinding::new("shift-right", SelectRight, ctx),
        KeyBinding::new("shift-up", SelectUp, ctx),
        KeyBinding::new("shift-down", SelectDown, ctx),
        KeyBinding::new("home", Home, ctx),
        KeyBinding::new("end", End, ctx),
        KeyBinding::new("enter", Newline, ctx),
        KeyBinding::new("shift-enter", Newline, ctx),
        KeyBinding::new(primary!("a"), SelectAll, ctx),
        KeyBinding::new(primary!("v"), Paste, ctx),
        KeyBinding::new(primary!("c"), Copy, ctx),
        KeyBinding::new(primary!("x"), Cut, ctx),
    ]
}

/// One shaped paragraph (text between newlines), at `start` bytes into the content.
struct Paragraph {
    start: usize,
    top: Pixels,
    line: WrappedLine,
}

/// Geometry of the last paint, in text coordinates (origin at the top-left of
/// the text, before scrolling).
struct Layout {
    paragraphs: Vec<Paragraph>,
    line_height: Pixels,
    height: Pixels,
}

impl Layout {
    fn paragraph_for_offset(&self, offset: usize) -> Option<&Paragraph> {
        self.paragraphs
            .iter()
            .rev()
            .find(|p| p.start <= offset)
            .or_else(|| self.paragraphs.first())
    }

    fn position_for_offset(&self, offset: usize) -> Point<Pixels> {
        let Some(p) = self.paragraph_for_offset(offset) else {
            return point(px(0.), px(0.));
        };
        let local = offset.saturating_sub(p.start).min(p.line.len());
        let pos = p
            .line
            .position_for_index(local, self.line_height)
            .unwrap_or_else(|| point(p.line.width(), px(0.)));
        point(pos.x, pos.y + p.top)
    }

    fn offset_for_position(&self, pos: Point<Pixels>) -> usize {
        let Some(first) = self.paragraphs.first() else {
            return 0;
        };
        if pos.y < px(0.) {
            return 0;
        }
        let p = self.paragraphs.iter().rev().find(|p| p.top <= pos.y).unwrap_or(first);
        let rows = p.line.size(self.line_height).height;
        let y = (pos.y - p.top).min(rows - px(1.)).max(px(0.));
        let local = match p
            .line
            .closest_index_for_position(point(pos.x.max(px(0.)), y), self.line_height)
        {
            Ok(i) | Err(i) => i,
        };
        p.start + local.min(p.line.len())
    }

    /// Rectangles covering `range`, one per visual row it touches.
    fn selection_rects(&self, range: &Range<usize>, width: Pixels) -> Vec<Bounds<Pixels>> {
        let mut out = Vec::new();
        let lh = self.line_height;
        for p in &self.paragraphs {
            let end = p.start + p.line.len();
            if range.end < p.start || range.start > end {
                continue;
            }
            let s = range.start.max(p.start) - p.start;
            let e = range.end.min(end) - p.start;
            let (Some(a), Some(b)) = (p.line.position_for_index(s, lh), p.line.position_for_index(e, lh)) else {
                continue;
            };
            let (a, b) = (point(a.x, a.y + p.top), point(b.x, b.y + p.top));
            if a.y == b.y {
                if b.x > a.x {
                    out.push(Bounds::from_corners(a, point(b.x, b.y + lh)));
                }
                continue;
            }
            out.push(Bounds::from_corners(a, point(width, a.y + lh)));
            if b.y > a.y + lh {
                out.push(Bounds::from_corners(point(px(0.), a.y + lh), point(width, b.y)));
            }
            out.push(Bounds::from_corners(
                point(px(0.), b.y),
                point(b.x.max(px(2.)), b.y + lh),
            ));
        }
        out
    }
}

pub(crate) struct TextArea {
    focus_handle: FocusHandle,
    content: String,
    placeholder: SharedString,
    selected_range: Range<usize>,
    selection_reversed: bool,
    marked_range: Option<Range<usize>>,
    layout: Option<Layout>,
    /// Where the text origin was painted, in window coordinates (includes scroll).
    text_origin: Option<Point<Pixels>>,
    scroll_y: Pixels,
    is_selecting: bool,
}

impl TextArea {
    pub fn new(placeholder: impl Into<SharedString>, cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            content: String::new(),
            placeholder: placeholder.into(),
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            layout: None,
            text_origin: None,
            scroll_y: px(0.),
            is_selecting: false,
        }
    }

    pub fn text(&self) -> &str {
        &self.content
    }

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed {
            self.selected_range.start
        } else {
            self.selected_range.end
        }
    }

    fn move_to(&mut self, offset: usize, window: &Window, cx: &mut Context<Self>) {
        self.selected_range = offset..offset;
        self.selection_reversed = false;
        window.notify_text_selection_changed(&self.focus_handle);
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, window: &Window, cx: &mut Context<Self>) {
        if self.selection_reversed {
            self.selected_range.start = offset;
        } else {
            self.selected_range.end = offset;
        }
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        window.notify_text_selection_changed(&self.focus_handle);
        cx.notify();
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .rev()
            .find_map(|(i, _)| (i < offset).then_some(i))
            .unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .find_map(|(i, _)| (i > offset).then_some(i))
            .unwrap_or(self.content.len())
    }

    /// The offset one visual row above (`dir < 0`) or below the cursor.
    fn vertical_offset(&self, dir: f32) -> usize {
        let cursor = self.cursor_offset();
        let Some(layout) = &self.layout else {
            return cursor;
        };
        let pos = layout.position_for_offset(cursor);
        let target_y = pos.y + layout.line_height * (0.5 + dir);
        if target_y < px(0.) {
            return 0;
        }
        if target_y >= layout.height {
            return self.content.len();
        }
        layout.offset_for_position(point(pos.x, target_y))
    }

    fn left(&mut self, _: &Left, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.previous_boundary(self.cursor_offset()), window, cx);
        } else {
            self.move_to(self.selected_range.start, window, cx);
        }
    }

    fn right(&mut self, _: &Right, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.next_boundary(self.selected_range.end), window, cx);
        } else {
            self.move_to(self.selected_range.end, window, cx);
        }
    }

    fn up(&mut self, _: &Up, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.vertical_offset(-1.0), window, cx);
    }

    fn down(&mut self, _: &Down, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.vertical_offset(1.0), window, cx);
    }

    fn select_left(&mut self, _: &SelectLeft, window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor_offset()), window, cx);
    }

    fn select_right(&mut self, _: &SelectRight, window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor_offset()), window, cx);
    }

    fn select_up(&mut self, _: &SelectUp, window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.vertical_offset(-1.0), window, cx);
    }

    fn select_down(&mut self, _: &SelectDown, window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.vertical_offset(1.0), window, cx);
    }

    fn select_all(&mut self, _: &SelectAll, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, window, cx);
        self.select_to(self.content.len(), window, cx);
    }

    fn line_start(&self, offset: usize) -> usize {
        self.content[..offset].rfind('\n').map_or(0, |i| i + 1)
    }

    fn line_end(&self, offset: usize) -> usize {
        self.content[offset..]
            .find('\n')
            .map_or(self.content.len(), |i| offset + i)
    }

    fn home(&mut self, _: &Home, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.line_start(self.cursor_offset()), window, cx);
    }

    fn end(&mut self, _: &End, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.line_end(self.cursor_offset()), window, cx);
    }

    fn newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        self.replace_text_in_range(None, "\n", window, cx);
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let prev = self.previous_boundary(self.cursor_offset());
            if prev == self.cursor_offset() {
                return;
            }
            self.select_to(prev, window, cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let next = self.next_boundary(self.cursor_offset());
            if next == self.cursor_offset() {
                return;
            }
            self.select_to(next, window, cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.replace_text_in_range(None, &text.replace("\r\n", "\n"), window, cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_owned(),
            ));
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_owned(),
            ));
            self.replace_text_in_range(None, "", window, cx);
        }
    }

    fn index_for_mouse(&self, position: Point<Pixels>) -> usize {
        match (&self.layout, self.text_origin) {
            (Some(layout), Some(origin)) => layout.offset_for_position(position - origin),
            _ => self.content.len(),
        }
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.is_selecting = true;
        let index = self.index_for_mouse(event.position);
        if event.modifiers.shift {
            self.select_to(index, window, cx);
        } else {
            self.move_to(index, window, cx);
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_selecting {
            self.select_to(self.index_for_mouse(event.position), window, cx);
        }
    }

    fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf8 = 0;
        let mut utf16 = 0;
        for ch in self.content.chars() {
            if utf16 >= offset {
                break;
            }
            utf16 += ch.len_utf16();
            utf8 += ch.len_utf8();
        }
        utf8
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let mut utf16 = 0;
        let mut utf8 = 0;
        for ch in self.content.chars() {
            if utf8 >= offset {
                break;
            }
            utf8 += ch.len_utf8();
            utf16 += ch.len_utf16();
        }
        utf16
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range.start)..self.offset_from_utf16(range.end)
    }
}

impl EntityInputHandler for TextArea {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_owned())
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected_range),
            reversed: self.selection_reversed,
        })
    }

    fn set_selected_text_range(&mut self, range_utf16: Range<usize>, window: &mut Window, cx: &mut Context<Self>) {
        self.selected_range = self.range_from_utf16(&range_utf16);
        self.selection_reversed = false;
        window.notify_text_selection_changed(&self.focus_handle);
        cx.notify();
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.content.encode_utf16().count())
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked_range.as_ref().map(|r| self.range_to_utf16(r))
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.marked_range = None;
        window.notify_text_input_changed(&self.focus_handle);
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        self.content.replace_range(range.clone(), new_text);
        let cursor = range.start + new_text.len();
        self.selected_range = cursor..cursor;
        self.selection_reversed = false;
        self.marked_range = None;
        window.notify_text_input_changed(&self.focus_handle);
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        self.content.replace_range(range.clone(), new_text);
        self.marked_range = (!new_text.is_empty()).then(|| range.start..range.start + new_text.len());
        let start_utf16 = self.offset_to_utf16(range.start);
        let len_utf16 = new_text.encode_utf16().count();
        self.selected_range = new_selected_range_utf16
            .map(|sel| {
                self.range_from_utf16(&(start_utf16 + sel.start.min(len_utf16)..start_utf16 + sel.end.min(len_utf16)))
            })
            .unwrap_or_else(|| range.start + new_text.len()..range.start + new_text.len());
        self.selection_reversed = false;
        window.notify_text_input_changed(&self.focus_handle);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        _element_bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let (layout, origin) = (self.layout.as_ref()?, self.text_origin?);
        let range = self.range_from_utf16(&range_utf16);
        let start = layout.position_for_offset(range.start);
        let end = layout.position_for_offset(range.end);
        let end = if end.y == start.y { end.x } else { start.x };
        Some(Bounds::from_corners(
            origin + start,
            origin + point(end.max(start.x), start.y + layout.line_height),
        ))
    }

    fn selection_bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        element_bounds: Bounds<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<Bounds<Pixels>> {
        self.bounds_for_range(range_utf16, element_bounds, window, cx)
            .into_iter()
            .collect()
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let (layout, origin) = (self.layout.as_ref()?, self.text_origin?);
        Some(self.offset_to_utf16(layout.offset_for_position(point - origin)))
    }
}

struct TextAreaElement {
    input: Entity<TextArea>,
}

struct Prepainted {
    layout: Layout,
    origin: Point<Pixels>,
    scroll_y: Pixels,
    placeholder: bool,
    cursor: Option<PaintQuad>,
    selection: Vec<PaintQuad>,
}

impl IntoElement for TextAreaElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for TextAreaElement {
    type RequestLayoutState = ();
    type PrepaintState = Option<Prepainted>;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let input = self.input.read(cx);
        let style = window.text_style();
        let placeholder = input.content.is_empty();
        let (text, color): (SharedString, _) = if placeholder {
            (input.placeholder.clone(), hsla(0., 0., 0., 0.35))
        } else {
            (input.content.clone().into(), style.color)
        };
        let run = TextRun {
            len: text.len(),
            font: style.font(),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let font_size = style.font_size.to_pixels(window.rem_size());
        let line_height = window.line_height();
        let lines = window
            .text_system()
            .shape_text(text, font_size, &[run], Some(bounds.size.width), None)
            .ok()?;

        let mut paragraphs = Vec::with_capacity(lines.len());
        let (mut start, mut top) = (0, px(0.));
        for line in lines {
            let len = line.len();
            let h = line.size(line_height).height;
            paragraphs.push(Paragraph { start, top, line });
            start += len + 1;
            top += h;
        }
        let layout = Layout {
            paragraphs,
            line_height,
            height: top,
        };

        let (cursor_offset, selected) = if placeholder {
            (0, 0..0)
        } else {
            (input.cursor_offset(), input.selected_range.clone())
        };
        let cursor_pos = layout.position_for_offset(cursor_offset);

        // Keep the cursor row inside the box.
        let mut scroll_y = input.scroll_y;
        let view_h = bounds.size.height;
        if cursor_pos.y < scroll_y {
            scroll_y = cursor_pos.y;
        } else if cursor_pos.y + line_height > scroll_y + view_h {
            scroll_y = cursor_pos.y + line_height - view_h;
        }
        scroll_y = scroll_y.min((layout.height - view_h).max(px(0.))).max(px(0.));
        let origin = point(bounds.left(), bounds.top() - scroll_y);

        let selection = layout
            .selection_rects(&selected, bounds.size.width)
            .into_iter()
            .map(|r| fill(Bounds::new(r.origin + origin, r.size), rgba(0x3b82f640)))
            .collect();
        let cursor = selected.is_empty().then(|| {
            fill(
                Bounds::new(cursor_pos + origin, size(px(1.5), line_height)),
                gpui::blue(),
            )
        });
        Some(Prepainted {
            layout,
            origin,
            scroll_y,
            placeholder,
            cursor,
            selection,
        })
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        prepainted: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus_handle = self.input.read(cx).focus_handle.clone();
        window.handle_input(&focus_handle, ElementInputHandler::new(bounds, self.input.clone()), cx);
        let Some(mut p) = prepainted.take() else {
            return;
        };
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for quad in p.selection.drain(..) {
                window.paint_quad(quad);
            }
            for para in &p.layout.paragraphs {
                let origin = point(p.origin.x, p.origin.y + para.top);
                if let Err(e) = para
                    .line
                    .paint(origin, p.layout.line_height, gpui::TextAlign::Left, None, window, cx)
                {
                    log::warn!("fixr: text paint failed: {e:#}");
                }
            }
            if focus_handle.is_focused(window)
                && let Some(cursor) = p.cursor.take()
            {
                window.paint_quad(cursor);
            }
        });
        let origin = p.origin;
        let scroll_y = p.scroll_y;
        let layout = (!p.placeholder).then_some(p.layout);
        self.input.update(cx, |input, _| {
            input.text_origin = Some(origin);
            input.scroll_y = scroll_y;
            input.layout = layout.or_else(|| {
                Some(Layout {
                    paragraphs: Vec::new(),
                    line_height: px(0.),
                    height: px(0.),
                })
            });
        });
    }
}

impl Render for TextArea {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .key_context(CONTEXT)
            .track_focus(&self.focus_handle)
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::copy))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .size_full()
            .child(TextAreaElement { input: cx.entity() })
    }
}

impl Focusable for TextArea {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}
