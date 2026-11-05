import type { DrawableSource, Rect } from "./image.js";

export interface DialogInput {
  image?: DrawableSource;
  maxPromptLength: number;
}

export interface DialogResult {
  prompt: string;
  /** Redaction rectangles in image pixels. */
  rects: Rect[];
  /** The user removed the screenshot. */
  removed: boolean;
}

export const ELEMENT_NAME = "fixr-report";

const CSS = `
:host { all: initial; color-scheme: light dark; position: fixed; inset: 0; z-index: 2147483647;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --bg: #fff; --fg: #111; --muted: #666; --line: #d0d0d0; --field: #f6f6f6; --accent: #2563eb; --accent-fg: #fff; --shade: rgba(0,0,0,.45); }
@media (prefers-color-scheme: dark) {
  :host { --bg: #1e1e1f; --fg: #ececec; --muted: #a0a0a0; --line: #3a3a3c; --field: #2a2a2c; --accent: #4f8cff; --accent-fg: #fff; --shade: rgba(0,0,0,.6); }
}
.backdrop { position: absolute; inset: 0; background: var(--shade); display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }
.panel { background: var(--bg); color: var(--fg); border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,.35);
  width: min(760px, 100%); max-height: 100%; overflow: auto; padding: 16px; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; }
h2 { margin: 0; font-size: 16px; font-weight: 600; }
.preview { position: relative; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--field); display: flex; justify-content: center; }
canvas { display: block; max-width: 100%; max-height: 50vh; cursor: crosshair; touch-action: none; }
.tools { display: flex; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; }
.tools .hint { flex: 1; }
textarea { font: inherit; color: inherit; background: var(--field); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px;
  min-height: 90px; resize: vertical; box-sizing: border-box; width: 100%; }
textarea:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.row { display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
.row .count { flex: 1; color: var(--muted); font-size: 12px; }
button { font: inherit; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; padding: 6px 14px; cursor: pointer; }
button.small { padding: 2px 8px; font-size: 12px; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button:disabled { opacity: .5; cursor: default; }
[hidden] { display: none !important; }
`;

const HTML = `
<div class="backdrop" part="backdrop">
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="fixr-title" part="panel">
    <h2 id="fixr-title">Report a UI issue</h2>
    <div class="preview" data-preview><canvas aria-label="Screenshot; drag to black out areas"></canvas></div>
    <div class="tools" data-tools>
      <span class="hint">Drag on the screenshot to black out sensitive areas.</span>
      <button type="button" class="small" data-undo disabled>Undo</button>
      <button type="button" class="small" data-remove>Remove screenshot</button>
    </div>
    <textarea data-prompt aria-label="What should change?" placeholder="What should change?"></textarea>
    <div class="row">
      <span class="count" data-count></span>
      <button type="button" data-cancel>Cancel</button>
      <button type="button" class="primary" data-send disabled>Send</button>
    </div>
  </div>
</div>`;

const FOCUSABLE = "button:not([disabled]):not([hidden]), textarea, [tabindex]:not([tabindex='-1'])";

function defineElement(): typeof HTMLElement | undefined {
  if (typeof customElements === "undefined" || typeof HTMLElement === "undefined") return undefined;
  const existing = customElements.get(ELEMENT_NAME);
  if (existing) return existing as typeof HTMLElement;

  class FixrReportElement extends HTMLElement {
    private root: ShadowRoot;
    private resolve: ((r: DialogResult | null) => void) | null = null;
    private rects: Rect[] = [];
    private image: DrawableSource | undefined;
    private removed = false;
    private restoreFocus: Element | null = null;
    private drag: { x0: number; y0: number; x1: number; y1: number } | null = null;

    constructor() {
      super();
      this.root = this.attachShadow({ mode: "open" });
      this.root.innerHTML = `<style>${CSS}</style>${HTML}`;
      const $ = <T extends Element>(s: string) => this.root.querySelector(s) as T;
      const prompt = $<HTMLTextAreaElement>("[data-prompt]");
      const send = $<HTMLButtonElement>("[data-send]");
      const count = $<HTMLSpanElement>("[data-count]");
      prompt.addEventListener("input", () => {
        const n = [...prompt.value.trim()].length;
        send.disabled = n === 0 || n > Number(prompt.maxLength > 0 ? prompt.maxLength : Infinity);
        count.textContent = prompt.value.length > 0.8 * prompt.maxLength ? `${n} / ${prompt.maxLength}` : "";
      });
      send.addEventListener("click", () => this.finish(true));
      $<HTMLButtonElement>("[data-cancel]").addEventListener("click", () => this.finish(false));
      $<HTMLButtonElement>("[data-undo]").addEventListener("click", () => {
        this.rects.pop();
        this.redraw();
      });
      $<HTMLButtonElement>("[data-remove]").addEventListener("click", () => {
        this.removed = true;
        this.rects = [];
        this.syncPreview();
        prompt.focus();
      });
      $<HTMLDivElement>(".backdrop").addEventListener("mousedown", (e) => {
        if (e.target === e.currentTarget) prompt.focus();
      });
      this.root.addEventListener("keydown", (e) => this.onKey(e as KeyboardEvent));
      const canvas = $<HTMLCanvasElement>("canvas");
      canvas.addEventListener("pointerdown", (e) => this.onPointer(e, "down"));
      canvas.addEventListener("pointermove", (e) => this.onPointer(e, "move"));
      canvas.addEventListener("pointerup", (e) => this.onPointer(e, "up"));
      canvas.addEventListener("pointercancel", () => {
        this.drag = null;
        this.redraw();
      });
    }

    connectedCallback() {
      // Attributes may not be added in the constructor; keep the host out of DOM captures.
      if (!this.hasAttribute("data-fixr-ignore")) this.setAttribute("data-fixr-ignore", "");
    }

    open(input: DialogInput): Promise<DialogResult | null> {
      if (this.resolve) this.finish(false);
      this.image = input.image;
      this.rects = [];
      this.removed = false;
      this.drag = null;
      const prompt = this.root.querySelector("[data-prompt]") as HTMLTextAreaElement;
      prompt.value = "";
      prompt.maxLength = input.maxPromptLength;
      prompt.dispatchEvent(new Event("input"));
      this.syncPreview();
      this.restoreFocus = document.activeElement;
      return new Promise((resolve) => {
        this.resolve = resolve;
        queueMicrotask(() => prompt.focus());
      });
    }

    close() {
      this.finish(false);
    }

    private finish(ok: boolean) {
      const resolve = this.resolve;
      if (!resolve) return;
      const prompt = (this.root.querySelector("[data-prompt]") as HTMLTextAreaElement).value.trim();
      if (ok && !prompt) return;
      this.resolve = null;
      const result = ok ? { prompt, rects: this.rects.slice(), removed: this.removed || !this.image } : null;
      this.image = undefined;
      this.remove();
      if (this.restoreFocus && (this.restoreFocus as HTMLElement).focus) (this.restoreFocus as HTMLElement).focus();
      resolve(result);
    }

    private onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.finish(false);
        return;
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.finish(true);
        return;
      }
      if (e.key === "Tab") {
        const items = Array.from(this.root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => !el.closest("[hidden]"),
        );
        if (!items.length) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = this.root.activeElement as HTMLElement | null;
        const idx = active ? items.indexOf(active) : -1;
        if (e.shiftKey && (idx <= 0)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (idx === -1 || idx === items.length - 1)) {
          e.preventDefault();
          first.focus();
        }
      }
      e.stopPropagation(); // keep the host page's shortcuts out while typing
    }

    private syncPreview() {
      const has = !!this.image && !this.removed;
      (this.root.querySelector("[data-preview]") as HTMLElement).hidden = !has;
      (this.root.querySelector("[data-tools]") as HTMLElement).hidden = !has;
      const canvas = this.root.querySelector("canvas") as HTMLCanvasElement;
      if (has) {
        canvas.width = this.image!.width;
        canvas.height = this.image!.height;
      }
      this.redraw();
    }

    private redraw() {
      (this.root.querySelector("[data-undo]") as HTMLButtonElement).disabled = this.rects.length === 0;
      if (!this.image || this.removed) return;
      const canvas = this.root.querySelector("canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext?.("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(this.image, 0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#000";
      for (const r of this.rects) ctx.fillRect(r.x, r.y, r.w, r.h);
      if (this.drag) {
        const r = normRect(this.drag);
        ctx.fillStyle = "rgba(0,0,0,.6)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    }

    private toImage(e: PointerEvent): { x: number; y: number } {
      const canvas = e.currentTarget as HTMLCanvasElement;
      const b = canvas.getBoundingClientRect();
      const sx = b.width ? canvas.width / b.width : 1;
      const sy = b.height ? canvas.height / b.height : 1;
      return {
        x: Math.max(0, Math.min(canvas.width, (e.clientX - b.left) * sx)),
        y: Math.max(0, Math.min(canvas.height, (e.clientY - b.top) * sy)),
      };
    }

    private onPointer(e: PointerEvent, phase: "down" | "move" | "up") {
      if (!this.image || this.removed) return;
      const p = this.toImage(e);
      if (phase === "down") {
        (e.currentTarget as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
        this.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      } else if (this.drag) {
        this.drag.x1 = p.x;
        this.drag.y1 = p.y;
        if (phase === "up") {
          const r = normRect(this.drag);
          this.drag = null;
          if (r.w >= 3 && r.h >= 3) this.rects.push(r);
        }
      }
      this.redraw();
    }
  }

  customElements.define(ELEMENT_NAME, FixrReportElement);
  return FixrReportElement;
}

function normRect(d: { x0: number; y0: number; x1: number; y1: number }): Rect {
  const x = Math.round(Math.min(d.x0, d.x1));
  const y = Math.round(Math.min(d.y0, d.y1));
  return { x, y, w: Math.round(Math.abs(d.x1 - d.x0)), h: Math.round(Math.abs(d.y1 - d.y0)) };
}

export interface FixrDialog extends HTMLElement {
  open(input: DialogInput): Promise<DialogResult | null>;
  close(): void;
}

export function createDialog(): FixrDialog | null {
  if (!defineElement()) return null;
  return document.createElement(ELEMENT_NAME) as FixrDialog;
}
