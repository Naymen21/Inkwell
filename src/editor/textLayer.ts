// Text boxes are DOM (crisp at any zoom, native editing, iPad Scribble works)
// positioned in page coordinates on top of the page canvas.
import type { StickyObj, TextObj } from '../model/types';
import { FONTS, TEXT_LINE } from '../render/draw';
import type { Editor } from './editor';
import { settings } from './settings';

export class TextLayer {
  private els = new Map<string, HTMLDivElement>();
  private editing: { id: string; el: HTMLDivElement; draft: TextObj | null; style: Pick<TextObj, 'size' | 'color' | 'bold' | 'font'> } | null = null;
  private dimT: number | null = null;

  constructor(private ed: Editor) {}

  get active() { return this.editing; }

  isEditingTarget(t: EventTarget | null) {
    return !!this.editing && t instanceof Node && this.editing.el.contains(t);
  }

  syncAll() {
    const st = this.ed.doc.state;
    for (const id of [...this.els.keys()]) if (!st.objects.has(id) && this.editing?.id !== id) this.drop(id);
    for (const o of st.objects.values()) if (o.kind === 'text') this.render(o); else if (o.kind === 'sticky') this.renderSticky(o);
  }

  sync(ids: Iterable<string>) {
    const st = this.ed.doc.state;
    for (const id of ids) {
      const o = st.objects.get(id);
      if (o?.kind === 'text') this.render(o);
      else if (o?.kind === 'sticky') this.renderSticky(o);
      else if (this.editing?.id !== id) this.drop(id);
    }
  }

  /**
   * Sticky note: collapsed it's a small icon; tap opens it. Drag the icon (or
   * the open card's top bar) to move it anywhere on the page.
   */
  private renderSticky(o: StickyObj) {
    const pv = this.ed.pageView(o.page);
    if (!pv) return;
    let el = this.els.get(o.id);
    if (el && el.dataset.open !== String(o.open)) { el.remove(); this.els.delete(o.id); el = undefined; }
    if (!el) {
      el = document.createElement('div');
      el.className = `sticky${o.open ? ' open' : ''}`;
      el.dataset.open = String(o.open);
      el.dataset.id = o.id;
      this.els.set(o.id, el);
      if (o.open) {
        const bar = document.createElement('div');
        bar.className = 'sticky-bar';
        bar.innerHTML = `<span class="sticky-grip" aria-hidden="true"></span>`;
        const fold = document.createElement('button');
        fold.className = 'sticky-btn';
        fold.setAttribute('aria-label', 'Collapse sticky note');
        fold.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 15l6-6 6 6"/></svg>';
        fold.onclick = () => this.stickyPatch(o.id, { open: false });
        const del = document.createElement('button');
        del.className = 'sticky-btn';
        del.setAttribute('aria-label', 'Delete sticky note');
        del.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        del.onclick = () => this.ed.doc.commit([{ t: 'remove', id: o.id }]);
        bar.append(fold, del);
        const area = document.createElement('textarea');
        area.className = 'sticky-text';
        area.placeholder = 'Write a note…';
        area.setAttribute('aria-label', 'Sticky note text');
        area.onkeydown = (e) => e.stopPropagation();
        area.onblur = () => {
          const cur = this.ed.doc.state.objects.get(o.id);
          if (cur?.kind === 'sticky' && cur.text !== area.value) this.stickyPatch(o.id, { text: area.value });
        };
        el.append(bar, area);
        this.dragSticky(el, bar, o.id);
      } else {
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', 'Open sticky note');
        el.tabIndex = 0;
        el.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 8h10M7 12h10M7 16h6"/></svg>';
        el.onkeydown = (e) => { if (e.key === 'Enter') this.stickyPatch(o.id, { open: true }); };
        this.dragSticky(el, el, o.id, () => this.stickyPatch(o.id, { open: true }));
      }
    }
    if (el.parentElement !== pv.textLayer) pv.textLayer.append(el);
    Object.assign(el.style, { left: `${o.x}px`, top: `${o.y}px`, background: o.color, ...(o.open ? { width: `${o.w}px`, height: `${o.h}px` } : {}) });
    const area = el.querySelector('textarea');
    if (area && document.activeElement !== area && area.value !== o.text) area.value = o.text;
    el.style.opacity = this.dimT != null && o.createdAt > this.dimT ? '0.18' : '';
  }

  private stickyPatch(id: string, patch: Partial<StickyObj>) {
    this.ed.doc.commit([{ t: 'update', id, patch }]);
  }

  /** Drag by `handle` (any tool, any pointer). A press without movement calls onTap. */
  private dragSticky(el: HTMLElement, handle: HTMLElement, id: string, onTap?: () => void) {
    handle.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.sticky-btn')) return;
      e.preventDefault();
      e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, z = this.ed.cam.z;
      let moved = false;
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
        if (!moved && Math.hypot(dx * z, dy * z) < 5) return;
        moved = true;
        el.style.transform = `translate(${dx}px, ${dy}px)`;
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        el.style.transform = '';
        const o = this.ed.doc.state.objects.get(id);
        if (!o || o.kind !== 'sticky') return;
        if (!moved) { onTap?.(); return; }
        const pv = this.ed.pageView(o.page)!;
        const x = Math.max(0, Math.min(pv.page.w - 30, o.x + (ev.clientX - sx) / z));
        const y = Math.max(0, Math.min(pv.page.h - 30, o.y + (ev.clientY - sy) / z));
        this.stickyPatch(id, { x, y });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  /** Open a new sticky and put the cursor in it. */
  focusSticky(id: string) {
    setTimeout(() => this.els.get(id)?.querySelector('textarea')?.focus(), 30);
  }

  private drop(id: string) {
    this.els.get(id)?.remove();
    this.els.delete(id);
  }

  private render(o: TextObj) {
    const pv = this.ed.pageView(o.page);
    if (!pv) return;
    let el = this.els.get(o.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'text-obj';
      el.spellcheck = false;
      this.els.set(o.id, el);
    }
    if (el.parentElement !== pv.textLayer) pv.textLayer.append(el);
    this.style(el, o);
    if (this.editing?.id !== o.id) el.textContent = o.text;
    el.style.opacity = this.dimT != null && o.createdAt > this.dimT ? '0.18' : '';
  }

  private style(el: HTMLDivElement, o: Pick<TextObj, 'x' | 'y' | 'w' | 'size' | 'color' | 'bold' | 'font'>) {
    Object.assign(el.style, {
      left: `${o.x}px`, top: `${o.y}px`, width: `${o.w}px`,
      fontSize: `${o.size}px`, lineHeight: String(TEXT_LINE), color: o.color,
      fontWeight: o.bold ? '700' : '400', fontFamily: FONTS[o.font],
    });
  }

  /** Start a new (not yet committed) text box; it only enters the document if non-empty. */
  draft(o: TextObj) {
    this.finish();
    const pv = this.ed.pageView(o.page);
    if (!pv) return;
    const el = document.createElement('div');
    el.className = 'text-obj';
    this.els.set(o.id, el);
    pv.textLayer.append(el);
    this.style(el, o);
    this.begin(o.id, el, o, o);
  }

  edit(id: string) {
    if (this.editing?.id === id) return;
    this.finish();
    const o = this.ed.doc.state.objects.get(id);
    const el = this.els.get(id);
    if (!el || o?.kind !== 'text') return;
    this.begin(id, el, null, o);
  }

  private begin(id: string, el: HTMLDivElement, draft: TextObj | null, o: TextObj) {
    el.contentEditable = 'plaintext-only';
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.classList.add('editing');
    el.spellcheck = true;
    this.editing = { id, el, draft, style: { size: o.size, color: o.color, bold: o.bold, font: o.font } };
    // Mirror the box's style into the toolbar so the text strip edits this box.
    Object.assign(settings.text, this.editing.style);
    this.ed.toolbar.renderStrip();
    el.onblur = () => this.finish();
    el.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') el.blur();
    };
    el.onpaste = (e) => {
      if (el.contentEditable === 'plaintext-only') return;
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
    };
    el.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  }

  /** Called from the toolbar while editing. */
  applyStyle() {
    const e = this.editing;
    if (!e) return;
    e.style = { size: settings.text.size, color: settings.text.color, bold: settings.text.bold, font: settings.text.font };
    const o = e.draft ?? (this.ed.doc.state.objects.get(e.id) as TextObj);
    this.style(e.el, { ...o, ...e.style });
  }

  finish() {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    const { id, el, draft, style } = e;
    el.onblur = null;
    el.contentEditable = 'false';
    el.classList.remove('editing');
    el.spellcheck = false;
    if (document.activeElement === el) el.blur();
    const text = el.innerText.replace(/\n+$/, '');
    const h = el.offsetHeight;
    if (draft) {
      if (text.trim()) this.ed.commitContent([{ t: 'add', obj: { ...draft, ...style, text, h } }], draft.page);
      else this.drop(id);
      return;
    }
    const o = this.ed.doc.state.objects.get(id);
    if (o?.kind !== 'text') return;
    if (!text.trim()) this.ed.doc.commit([{ t: 'remove', id }]);
    else if (text !== o.text || Math.abs(h - o.h) > 0.5 || style.size !== o.size || style.color !== o.color || style.bold !== o.bold || style.font !== o.font)
      this.ed.doc.commit([{ t: 'update', id, patch: { text, h, ...style } }]);
    else el.textContent = o.text;
  }

  preview(id: string, dx: number, dy: number, s: number, ox: number, oy: number) {
    const el = this.els.get(id);
    if (!el) return;
    el.style.transformOrigin = `${ox}px ${oy}px`;
    el.style.transform = s !== 1 ? `scale(${s})` : `translate(${dx}px, ${dy}px)`;
  }

  clearPreview() {
    for (const el of this.els.values()) el.style.transform = '';
  }

  setDim(t: number | null) {
    this.dimT = t;
    const st = this.ed.doc.state;
    for (const [id, el] of this.els) {
      const o = st.objects.get(id);
      el.style.opacity = t != null && o && o.createdAt > t ? '0.18' : '';
    }
  }
}
