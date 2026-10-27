// Text boxes are DOM (crisp at any zoom, native editing, iPad Scribble works)
// positioned in page coordinates on top of the page canvas.
import type { TextObj } from '../model/types';
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
    for (const o of st.objects.values()) if (o.kind === 'text') this.render(o);
  }

  sync(ids: Iterable<string>) {
    const st = this.ed.doc.state;
    for (const id of ids) {
      const o = st.objects.get(id);
      if (o?.kind === 'text') this.render(o);
      else if (this.editing?.id !== id) this.drop(id);
    }
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
