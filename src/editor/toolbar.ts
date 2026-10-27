// Editor chrome, floating over a full-bleed canvas: back + title on the left,
// a centered glass dock (tools row + contextual options row), undo/redo/more/
// pages on the right, plus the pages sidebar, selection menu and playback bar.
import type { Op, Template } from '../model/types';
import { icons } from '../ui/icons';
import { busy, confirmBox, esc, menu, sheet, toast } from '../ui/modal';
import { openSettings } from '../ui/settingsPanel';
import { renderPageToCanvas } from '../render/draw';
import type { Editor } from './editor';
import { newPage } from './editor';
import { exportNoteFile, exportPdf, pdfToPages, safeName, saveBlob } from './io';
import { DEFAULT_DOCK, HL_COLORS, PAPER_COLORS, PEN_COLORS, saveSettings, settings, type DockItem, type ToolName } from './settings';
import { hasClipboard } from './tools';
import { db } from '../persist/db';
import { InklyPanel } from './inkly';
import { pickFile } from '../ui/pickFiles';
import { Recorder } from './audio';
import { inClaude } from '../util/claude';
import { findOutlineWithAI } from './aiOutline';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

const TOOLS: { name: ToolName; icon: string; label: string }[] = [
  { name: 'pen', icon: icons.nbPen, label: 'Pen (P)' },
  { name: 'shape', icon: icons.nbShape, label: 'Shapes (S)' },
  { name: 'highlighter', icon: icons.nbHighlighter, label: 'Highlighter (H)' },
  { name: 'eraser', icon: icons.nbEraser, label: 'Eraser (E)' },
  { name: 'text', icon: icons.nbText, label: 'Text (T)' },
  { name: 'lasso', icon: icons.nbSelect, label: 'Select (L)' },
];

const ERASER_SIZES = [10, 18, 32];

function paleInk(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const v = parseInt(m[1], 16);
  return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255) > 185;
}

const fmt = (t: number) => {
  t = Math.max(0, Math.floor(t));
  const hh = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (hh ? `${hh}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
};


type ExportChoice = { format: 'pdf' | 'note'; background: boolean; range: 'all' | 'current' };

export class Toolbar {
  readonly el = h('div', 'ed-chrome');
  readonly pagesPanel = h('aside', 'pages-panel glass');
  readonly selMenu = h('div', 'sel-menu');
  readonly playbar = h('div', 'playbar glass');
  readonly pageBadge = h('div', 'page-badge');
  readonly inkly: InklyPanel;
  private dock = h('div', 'dock glass');
  private opts = h('div', 'dock-opts');
  private toolBtns = new Map<ToolName, HTMLButtonElement>();
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private recBtn!: HTMLButtonElement;
  private handBtn!: HTMLButtonElement;
  private pagesBtn!: HTMLButtonElement;
  private recTimer = 0;
  private badgeTimer = 0;
  private thumbTimer = 0;
  private scrub!: HTMLInputElement;
  private timeLbl!: HTMLSpanElement;
  private playBtn!: HTMLButtonElement;
  private rateBtn!: HTMLButtonElement;
  private optsKey = '';
  private dockBtns = new Map<DockItem, HTMLButtonElement>();
  private toolsRow = h('div', 'dock-tools');
  private collapseBtn!: HTMLButtonElement;

  /** Lay out the dock from the saved order, skipping hidden items. */
  layoutDock() {
    const row = this.toolsRow;
    row.replaceChildren();
    let utilityStarted = false;
    for (const slot of settings.dock) {
      const b = this.dockBtns.get(slot.id);
      if (!b || slot.hidden) continue;
      if (slot.id === 'mic' && !Recorder.supported()) continue;
      // A divider before the finger-drawing switch, as in Notability.
      if (slot.id === 'hand' && row.childElementCount && !utilityStarted) { row.append(h('span', 'vsep')); utilityStarted = true; }
      row.append(b);
    }
    row.append(this.collapseBtn);
  }

  /** Reorder (drag the handle) and show/hide dock items. */
  customizeSheet() {
    const labels: Record<DockItem, string> = {
      pen: 'Pen', shape: 'Shapes', highlighter: 'Highlighter', eraser: 'Eraser', text: 'Text', lasso: 'Select',
      insert: 'Insert', mic: 'Record audio', hand: 'Draw with finger',
    };
    const iconFor = (id: DockItem) => TOOLS.find((t) => t.name === id)?.icon ?? (id === 'insert' ? icons.insert : id === 'mic' ? icons.mic : icons.nbHand);
    sheet((box, close) => {
      const head = h('div', 'pop-head');
      const reset = h('button', 'link-btn', 'Reset');
      const done = h('button', 'link-btn strong', 'Done');
      head.append(reset, h('b', '', 'Customize toolbar'), done);
      const list = h('div', 'set-group dock-list');
      const render = () => {
        list.replaceChildren();
        for (const slot of settings.dock) {
          const row = h('div', `dock-row${slot.hidden ? ' off' : ''}`);
          row.dataset.id = slot.id;
          const grip = h('span', 'grip', icons.menu);
          grip.setAttribute('aria-label', `Drag to reorder ${labels[slot.id]}`);
          const sw = h('input', 'switch');
          sw.type = 'checkbox';
          sw.checked = !slot.hidden;
          sw.setAttribute('aria-label', `Show ${labels[slot.id]}`);
          sw.onchange = () => { slot.hidden = !sw.checked; row.classList.toggle('off', slot.hidden); commit(); };
          row.append(grip, h('span', 'dock-row-icon', iconFor(slot.id)), h('span', 'set-label', esc(labels[slot.id])), sw);
          grip.onpointerdown = (e) => startDrag(e, row);
          list.append(row);
        }
      };
      const commit = () => {
        const order = [...list.querySelectorAll<HTMLElement>('.dock-row')].map((r) => r.dataset.id as DockItem);
        settings.dock = order.map((id) => ({ id, hidden: settings.dock.find((s) => s.id === id)!.hidden }));
        saveSettings();
        this.layoutDock();
        this.update();
      };
      // Drag: the row follows the pointer; it swaps places as it crosses another row's middle.
      const startDrag = (e: PointerEvent, row: HTMLElement) => {
        e.preventDefault();
        // Listen on the window: re-inserting the row in the list drops pointer capture.
        const id = e.pointerId;
        row.classList.add('dragging');
        const move = (ev: PointerEvent) => {
          if (ev.pointerId !== id) return;
          for (const other of list.querySelectorAll<HTMLElement>('.dock-row')) {
            if (other === row) continue;
            const r = other.getBoundingClientRect();
            const mid = r.top + r.height / 2;
            const before = !!(row.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_PRECEDING);
            if (before && ev.clientY < mid && ev.clientY > r.top) { list.insertBefore(row, other); break; }
            if (!before && ev.clientY > mid && ev.clientY < r.bottom) { list.insertBefore(row, other.nextSibling); break; }
          }
        };
        const up = (ev: PointerEvent) => {
          if (ev.pointerId !== id) return;
          row.classList.remove('dragging');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          commit();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      };
      reset.onclick = () => { settings.dock = DEFAULT_DOCK.map((id) => ({ id, hidden: false })); render(); commit(); };
      done.onclick = close;
      render();
      box.append(head, h('p', 'set-note', 'Drag ☰ to reorder. Turn items off to hide them. Tip: long-press the toolbar to open this.'), list);
    }, undefined, 'sheet-md');
  }

  constructor(private ed: Editor) {
    this.inkly = new InklyPanel(ed);
    this.buildChrome();
    this.buildPlaybar();
    this.buildPagesPanel();
    this.renderStrip();
  }

  private btn(icon: string, label: string, onClick: (b: HTMLButtonElement) => void, cls = 'icon-btn') {
    const b = h('button', cls, icon);
    b.title = label;
    b.setAttribute('aria-label', label);
    b.onclick = () => onClick(b);
    return b;
  }

  // ---------------------------------------------------------------- layout

  private buildChrome() {
    const ed = this.ed;
    const left = h('div', 'float-left');
    left.append(this.btn(icons.nbBack, 'Library', () => ed.onExit(), 'icon-btn nb-tile'));
    const title = h('input', 'title-input');
    title.value = ed.meta.title;
    title.setAttribute('aria-label', 'Note title');
    title.onchange = () => { ed.meta.title = title.value.trim() || 'Untitled note'; title.value = ed.meta.title; ed.saveMeta(); };
    title.onkeydown = (e) => { if (e.key === 'Enter') title.blur(); };
    left.append(title);
    this.outlineBtn = this.btn(icons.menu, 'Outline', () => this.toggleOutline(), 'icon-btn nb-tile outline-btn');
    left.append(this.outlineBtn);

    for (const t of TOOLS) {
      const b = this.btn(`${t.icon}<span class="ink-dot"></span>`, t.label, () => ed.setTool(t.name), 'icon-btn tool-btn');
      this.toolBtns.set(t.name, b);
      this.dockBtns.set(t.name, b);
    }
    this.dockBtns.set('insert', this.btn(icons.insert, 'Insert', (b) => this.insertMenu(b), 'icon-btn tool-btn'));
    this.recBtn = this.btn(icons.mic, 'Record audio', () => ed.toggleRecord(), 'icon-btn tool-btn rec-btn');
    this.handBtn = this.btn(icons.nbHand, 'Draw with finger', () => {
      settings.fingerDraw = !settings.fingerDraw;
      saveSettings();
      toast(settings.fingerDraw ? 'Finger drawing on — two fingers scroll' : 'Finger drawing off — fingers scroll, palm is ignored');
      this.update();
    }, 'icon-btn tool-btn');
    const collapse = this.btn(icons.chevronRight, 'Hide options', () => {
      const c = this.dock.classList.toggle('collapsed');
      collapse.setAttribute('aria-label', c ? 'Show options' : 'Hide options');
      collapse.title = c ? 'Show options' : 'Hide options';
    }, 'icon-btn tool-btn collapse-btn');
    this.dockBtns.set('mic', this.recBtn);
    this.dockBtns.set('hand', this.handBtn);
    this.collapseBtn = collapse;
    this.dock.append(this.toolsRow, this.opts);
    this.layoutDock();
    // Long-press the dock to customize it (like rearranging a toolbar on iPad).
    let press = 0;
    this.dock.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.dock-opts')) return;
      press = window.setTimeout(() => { press = 0; this.customizeSheet(); }, 650);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'] as const) {
      this.dock.addEventListener(ev, (e) => { if (ev !== 'pointermove' || (e as PointerEvent).movementX || (e as PointerEvent).movementY) clearTimeout(press); });
    }

    const right = h('div', 'float-right glass');
    this.undoBtn = this.btn(icons.undo, 'Undo', () => ed.doc.undo());
    this.redoBtn = this.btn(icons.redo, 'Redo', () => ed.doc.redo());
    this.pagesBtn = this.btn(icons.nbPages, 'Pages', () => this.togglePages());
    right.append(this.undoBtn, this.redoBtn, this.btn(icons.nbMore, 'More', (b) => this.moreMenu(b)), this.pagesBtn);
    const ask = h('button', 'ask-inkly', `<span class="inkly-avatar xs">${icons.inkly}</span><span>Ask Inkly</span>`);
    ask.setAttribute('aria-label', 'Ask Inkly, your AI study assistant');
    ask.onclick = () => { this.togglePages(false); this.inkly.toggle(); };
    const rightWrap = h('div', 'right-wrap');
    rightWrap.append(right, ask);

    this.el.append(left, this.dock, rightWrap);
  }

  update() {
    const ed = this.ed;
    for (const [n, b] of this.toolBtns) {
      b.classList.toggle('active', settings.tool === n);
      const c = n === 'highlighter' ? settings.highlighter.color : n === 'pen' || n === 'shape' ? settings.pen.color : n === 'text' ? settings.text.color : '';
      b.style.setProperty('--ink', c || 'transparent');
      // Active icon takes its ink color, unless that ink is too pale to read (white, yellow).
      b.style.setProperty('--tint', c && !paleInk(c) ? c : 'var(--accent)');
    }
    this.undoBtn.disabled = !ed.doc.canUndo;
    this.redoBtn.disabled = !ed.doc.canRedo;
    this.handBtn.classList.toggle('active', settings.fingerDraw);
    const rec = ed.recorder.active;
    this.recBtn.classList.toggle('recording', rec);
    this.dock.classList.toggle('is-recording', rec);
    clearInterval(this.recTimer);
    if (rec) {
      const tick = () => { this.recBtn.innerHTML = `<span class="rec-dot"></span><span class="rec-time">${fmt(ed.recorder.elapsed())}</span>`; };
      tick();
      this.recTimer = window.setInterval(tick, 500);
    } else this.recBtn.innerHTML = icons.mic;
    this.renderStrip();
    this.updatePlaybar();
  }

  // ---------------------------------------------------------------- options row

  renderStrip() {
    const tool = settings.tool;
    const key = JSON.stringify([tool, settings.pen, settings.highlighter, settings.eraser, settings.text, settings.lassoMode, this.ed.playT != null, hasClipboard(), settings.recentColors, settings.penFavorites, settings.hlFavorites, settings.autoDeselectEraser]);
    if (key === this.optsKey) return;
    this.optsKey = key;
    const s = this.opts;
    s.innerHTML = '';
    if (this.ed.playT != null) {
      s.append(h('span', 'strip-hint', 'Playback — tap any writing to hear that moment'));
      return;
    }
    const save = () => { saveSettings(); this.update(); };
    // Sizes first so they're always visible, then favorites, then colors (which scroll).
    if (tool === 'pen' || tool === 'shape') {
      this.sizes(s, settings.penWidths, settings.pen.width, (w) => { settings.pen.width = w; save(); });
      s.append(h('span', 'vsep'));
      this.favorites(s);
      s.append(h('span', 'vsep'));
      this.colors(s, PEN_COLORS, settings.pen.color, (c) => { settings.pen.color = c; save(); });
    } else if (tool === 'highlighter') {
      this.sizes(s, settings.hlWidths, settings.highlighter.width, (w) => { settings.highlighter.width = w; save(); });
      s.append(h('span', 'vsep'));
      this.favorites(s);
      s.append(h('span', 'vsep'));
      this.colors(s, HL_COLORS, settings.highlighter.color, (c) => { settings.highlighter.color = c; save(); });
    } else if (tool === 'eraser') {
      this.sizes(s, ERASER_SIZES, settings.eraser.size, (w) => { settings.eraser.size = w; save(); });
      s.append(h('span', 'vsep'));
      s.append(
        this.chip(icons.whole, 'Whole', settings.eraser.mode === 'stroke', () => { settings.eraser.mode = 'stroke'; save(); }),
        this.chip(icons.partial, 'Partial', settings.eraser.mode === 'partial', () => { settings.eraser.mode = 'partial'; save(); }),
        this.chip(icons.highlighter, 'Highlights only', settings.eraser.highlighterOnly, () => { settings.eraser.highlighterOnly = !settings.eraser.highlighterOnly; save(); }),
        this.chip(icons.undo, 'Auto-switch back', settings.autoDeselectEraser, () => { settings.autoDeselectEraser = !settings.autoDeselectEraser; save(); }),
      );
    } else if (tool === 'lasso') {
      s.append(
        this.chip(icons.freeform, 'Freeform', settings.lassoMode === 'free', () => { settings.lassoMode = 'free'; save(); }),
        this.chip(icons.select, 'Rectangle', settings.lassoMode === 'rect', () => { settings.lassoMode = 'rect'; save(); }),
      );
      if (hasClipboard()) s.append(h('span', 'vsep'), this.chip(icons.copy, 'Paste', false, () => this.ed.pasteHere()));
    } else if (tool === 'text') {
      const t = settings.text;
      const apply = () => { this.ed.text.applyStyle(); save(); };
      // Keep focus in the text box while using these controls.
      const keep = <T extends HTMLElement>(b: T) => { b.onpointerdown = (e) => e.preventDefault(); return b; };
      const font = h('select', 'select');
      for (const [v, l] of [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono'], ['hand', 'Hand']]) {
        const o = h('option', '', l); o.value = v; font.append(o);
      }
      font.value = t.font;
      font.onchange = () => { t.font = font.value as typeof t.font; apply(); };
      const minus = keep(h('button', 'chip', 'A−'));
      minus.onclick = () => { t.size = Math.max(8, t.size - 2); apply(); };
      const sz = h('span', 'strip-num', `${t.size}`);
      const plus = keep(h('button', 'chip', 'A+'));
      plus.onclick = () => { t.size = Math.min(96, t.size + 2); apply(); };
      const bold = keep(h('button', `chip${t.bold ? ' on' : ''}`, '<b>B</b>'));
      bold.onclick = () => { t.bold = !t.bold; apply(); };
      s.append(font, minus, sz, plus, bold, h('span', 'vsep'));
      this.colors(s, PEN_COLORS, t.color, (c) => { t.color = c; apply(); }, true);
    }
  }

  /**
   * Five favorites for the current tool (pen and highlighter each have their
   * own): tap to use, long-press (or right-click) to save the current
   * color and size there. Never switches tools.
   */
  private favorites(s: HTMLElement) {
    const hl = settings.tool === 'highlighter';
    const list = hl ? settings.hlFavorites : settings.penFavorites;
    const cur = hl ? settings.highlighter : settings.pen;
    list.forEach((f, i) => {
      const on = cur.color.toLowerCase() === f.color.toLowerCase() && Math.abs(cur.width - f.width) < 0.01;
      const b = h('button', `fav${on ? ' on' : ''}`);
      const w = Math.max(2, Math.min(10, hl ? f.width * 0.45 : f.width * 1.4));
      b.innerHTML = `<svg viewBox="0 0 30 20" width="30" height="20" aria-hidden="true"><path d="M4 13c5-7 9 3 13-2s6-6 9-3" fill="none" stroke="${f.color}" stroke-width="${w}" stroke-linecap="round" ${hl ? 'stroke-opacity="0.6"' : ''}/></svg>`;
      b.setAttribute('aria-label', `Favorite ${i + 1}. Long-press to save the current ${hl ? 'highlighter' : 'pen'} here.`);
      b.title = 'Tap to use · long-press to save the current color and size here';
      const store = () => {
        list[i] = { color: cur.color, width: cur.width };
        saveSettings();
        toast(`Saved to favorite ${i + 1}`);
        this.optsKey = '';
        this.renderStrip();
      };
      let timer = 0, long = false;
      b.onpointerdown = () => { long = false; timer = window.setTimeout(() => { long = true; store(); }, 550); };
      b.onpointerup = b.onpointerleave = () => clearTimeout(timer);
      b.oncontextmenu = (e) => { e.preventDefault(); clearTimeout(timer); if (!long) store(); long = true; };
      b.onclick = () => {
        if (long) return;
        cur.color = f.color;
        cur.width = f.width;
        saveSettings();
        this.update();
      };
      s.append(b);
    });
  }

  private chip(icon: string, label: string, on: boolean, fn: () => void) {
    const b = h('button', `chip${on ? ' on' : ''}`, `${icon}<span>${esc(label)}</span>`);
    b.onclick = fn;
    return b;
  }

  private colors(s: HTMLElement, list: string[], current: string, set: (c: string) => void, keepFocus = false) {
    const all = [...new Set([...list, ...settings.recentColors.filter((c) => !list.includes(c)).slice(0, 2)])];
    for (const c of all) {
      const b = h('button', `swatch${c.toLowerCase() === current.toLowerCase() ? ' on' : ''}`);
      b.style.setProperty('--c', c);
      b.title = c;
      b.setAttribute('aria-label', `Color ${c}`);
      if (keepFocus) b.onpointerdown = (e) => e.preventDefault();
      b.onclick = () => set(c);
      s.append(b);
    }
    const custom = h('label', 'swatch custom');
    custom.title = 'Custom color';
    const inp = h('input');
    inp.type = 'color';
    inp.value = current;
    inp.onchange = () => {
      settings.recentColors = [inp.value, ...settings.recentColors.filter((c) => c !== inp.value)].slice(0, 4);
      set(inp.value);
    };
    custom.append(inp);
    s.append(custom);
  }

  /** Three size dots: small / medium / large. */
  private sizes(s: HTMLElement, list: number[], current: number, set: (w: number) => void) {
    list.forEach((w, i) => {
      const b = h('button', `size-btn${Math.abs(w - current) < 0.01 ? ' on' : ''}`);
      const d = h('span', 'size-dot');
      const px = [5, 9, 13][i] ?? 9;
      Object.assign(d.style, { width: `${px}px`, height: `${px}px` });
      b.append(d);
      b.title = `${w}pt`;
      b.setAttribute('aria-label', ['Small', 'Medium', 'Large'][i] ?? `${w}`);
      b.onclick = () => set(w);
      s.append(b);
    });
  }

  // ---------------------------------------------------------------- selection menu

  showSelMenu() {
    const lasso = this.ed.tools.lasso;
    if (!lasso.sel) return this.hideSelMenu();
    const m = this.selMenu;
    m.innerHTML = '';
    const act = (label: string, fn: () => void, cls = '') => {
      const b = h('button', `sel-btn ${cls}`, esc(label));
      b.onclick = fn;
      m.append(b);
    };
    act('Delete', () => lasso.remove(), 'danger');
    act('Duplicate', () => lasso.duplicate());
    act('Copy', () => { lasso.copy(); toast('Copied'); this.renderStrip(); });
    act('Cut', () => { lasso.copy(); lasso.remove(); this.renderStrip(); });
    const objs = lasso.objects();
    if (objs.length === 1 && objs[0].kind === 'text') {
      const id = objs[0].id;
      act('Edit', () => { this.ed.setTool('text'); this.ed.text.edit(id); });
    }
    if (objs.some((o) => o.kind !== 'image')) {
      m.append(h('span', 'vsep'));
      for (const c of ['#1c1c1e', '#e5484d', '#30a46c', '#3e7bfa', '#8e4ec6']) {
        const b = h('button', 'swatch small');
        b.style.setProperty('--c', c);
        b.setAttribute('aria-label', `Recolor ${c}`);
        b.onclick = () => lasso.recolor(c);
        m.append(b);
      }
    }
    m.classList.add('show');
    this.positionSelMenu();
  }

  hideSelMenu() { this.selMenu.classList.remove('show'); }

  positionSelMenu() {
    const sel = this.ed.tools.lasso.sel;
    if (!sel || !this.selMenu.classList.contains('show')) return;
    const r = this.ed.worldToScreenRect(sel.bounds);
    const m = this.selMenu;
    const mw = m.offsetWidth, mh = m.offsetHeight;
    const vr = this.ed.viewport.getBoundingClientRect();
    let top = r.y - mh - 18;
    if (top < vr.top + 120) top = Math.min(r.y + r.h + 22, vr.bottom - mh - 12);
    const left = Math.min(window.innerWidth - mw - 8, Math.max(8, r.x + r.w / 2 - mw / 2));
    m.style.transform = `translate(${left}px, ${top}px)`;
  }

  // ---------------------------------------------------------------- playback bar

  private buildPlaybar() {
    const ed = this.ed;
    this.playBtn = this.btn(icons.play, 'Play', () => {
      const p = ed.ensurePlayer();
      if (p.playing) p.pause();
      else {
        if (ed.playT == null) p.t = 0;
        p.play();
      }
    }, 'icon-btn play-btn');
    this.timeLbl = h('span', 'play-time');
    this.scrub = h('input', 'scrub');
    this.scrub.type = 'range';
    this.scrub.min = '0';
    this.scrub.step = '0.1';
    this.scrub.setAttribute('aria-label', 'Playback position');
    this.scrub.oninput = () => { ed.ensurePlayer().seek(+this.scrub.value); };
    this.rateBtn = h('button', 'chip rate', '1×');
    this.rateBtn.onclick = () => {
      const r = ed.player?.rate ?? 1;
      this.setRate(r === 1 ? 1.5 : r === 1.5 ? 2 : r === 2 ? 0.75 : 1);
    };
    const list = this.btn(icons.waveform, 'Recordings', (b) => this.recordingsPopover(b));
    const close = this.btn(icons.close, 'Exit playback', () => ed.exitReplay(), 'icon-btn play-close');
    this.playbar.append(this.playBtn, this.timeLbl, this.scrub, this.rateBtn, list, close);
  }

  private setRate(r: number) {
    this.ed.ensurePlayer().setRate(r);
    this.rateBtn.textContent = `${r}×`;
  }

  private updatePlaybar() {
    const ed = this.ed;
    const has = ed.meta.clips.length > 0 && !ed.recorder.active;
    this.playbar.classList.toggle('show', has);
    this.playbar.classList.toggle('replay', ed.playT != null);
    ed.root.classList.toggle('has-playbar', has);
    this.playBtn.innerHTML = ed.player?.playing ? icons.pause : icons.play;
    this.updateTime();
  }

  updateTime() {
    const ed = this.ed;
    const total = ed.meta.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    const t = ed.playT ?? 0;
    this.scrub.max = String(total);
    this.scrub.value = String(t);
    this.timeLbl.textContent = `${fmt(t)} / ${fmt(total)}`;
    this.scrub.style.setProperty('--p', `${total ? (t / total) * 100 : 0}%`);
  }

  /** Recordings list + playback speed, as a popover above the playbar. */
  private recordingsPopover(anchor: HTMLElement) {
    const ed = this.ed;
    sheet((box, close) => {
      const head = h('div', 'pop-head', '<span></span><b>Recordings</b>');
      const done = h('button', 'link-btn', 'Done');
      done.onclick = close;
      head.append(done);
      const group = h('div', 'set-group');
      ed.meta.clips.forEach((c, i) => {
        const row = h('div', 'rec-row');
        const play = this.btn(icons.play, `Play recording ${i + 1}`, () => { close(); const p = ed.ensurePlayer(); p.seek(c.start).then(() => p.play()); }, 'icon-btn round-play');
        const txt = h('div', 'set-text', `<span class="set-label">Recording ${i + 1}</span><span class="set-desc">${fmt(c.duration)} · starts at ${fmt(c.start)}</span>`);
        const del = this.btn(icons.trash, `Delete recording ${i + 1}`, async () => {
          if (!(await confirmBox('Delete recording?', 'The audio is removed. Your notes stay.'))) return;
          ed.exitReplay();
          ed.meta.clips = ed.meta.clips.filter((x) => x !== c);
          if (ed.player) ed.player.clips = ed.meta.clips;
          await db.deleteAudio(c.id);
          await ed.saveMeta();
          close();
          ed.toolbar.update();
        }, 'icon-btn danger-icon');
        row.append(play, txt, del);
        group.append(row);
      });
      const speed = h('div', 'set-group pad');
      const seg = h('div', 'segmented wide');
      const cur = ed.player?.rate ?? 1;
      for (const r of [0.75, 1, 1.5, 2]) {
        const b = h('button', cur === r ? 'on' : '', r === 1 ? 'Normal' : `${r}×`);
        b.onclick = () => { this.setRate(r); seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
        seg.append(b);
      }
      speed.append(seg);
      box.append(head, group, h('div', 'set-caption', 'Playback speed'), speed);
      this.anchorPopover(box, anchor, true);
    }, undefined, 'popover');
  }

  /** Position a sheet as a popover next to an anchor (wide screens only). */
  private anchorPopover(box: HTMLElement, anchor: HTMLElement, above = false) {
    if (window.innerWidth <= 600) return;
    box.classList.add('pop');
    requestAnimationFrame(() => {
      const r = anchor.getBoundingClientRect();
      const bw = box.offsetWidth, bh = box.offsetHeight;
      const left = Math.min(window.innerWidth - bw - 10, Math.max(10, r.left + r.width / 2 - bw / 2));
      const top = above ? Math.max(10, r.top - bh - 10) : Math.min(window.innerHeight - bh - 10, r.bottom + 10);
      Object.assign(box.style, { left: `${left}px`, top: `${top}px` });
    });
  }

  // ---------------------------------------------------------------- pages panel

  private buildPagesPanel() {
    const head = h('div', 'pp-head', '<b>All pages</b>');
    head.append(this.btn(icons.close, 'Close pages', () => this.togglePages(false), 'icon-btn small'));
    const list = h('div', 'pp-list');
    const add = h('button', 'pp-add', `${icons.plus}<span>Add page</span>`);
    add.onclick = () => {
      const st = this.ed.doc.state;
      const last = st.pages[st.pages.length - 1];
      this.ed.doc.commit([{ t: 'addPage', page: newPage(last), after: last.id }]);
      const pv = this.ed.pages[this.ed.pages.length - 1];
      if (pv) this.ed.scrollToPage(pv);
    };
    this.pagesPanel.append(head, list, add);
  }

  private togglePages(open = !this.pagesPanel.classList.contains('open')) {
    if (open) this.inkly.toggle(false);
    this.pagesPanel.classList.toggle('open', open);
    this.pagesBtn.classList.toggle('active', open);
    if (open) this.renderThumbs();
  }

  /** Called by the editor on every document change. */
  docChanged(layout: boolean) {
    if (!this.pagesPanel.classList.contains('open')) return;
    clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => this.renderThumbs(), layout ? 0 : 700);
  }

  // ---------------------------------------------------------------- outline (left, Google Docs style)

  readonly outlinePanel = h('nav', 'outline-panel');
  private outlineBtn!: HTMLButtonElement;
  private outlineOpen = (() => { try { return localStorage.getItem('inkwell.outlineOpen') !== '0'; } catch { return true; } })();

  private toggleOutline(open = !this.outlineOpen) {
    this.outlineOpen = open;
    try { localStorage.setItem('inkwell.outlineOpen', open ? '1' : '0'); } catch { /* ignore */ }
    this.renderOutline();
  }

  /** The note's table of contents down the left side; the section you're in is marked in red. */
  renderOutline() {
    const ed = this.ed;
    const entries = (ed.meta.outline ?? []).filter((e) => ed.pageView(e.page));
    const has = entries.length > 0;
    this.outlineBtn.hidden = !has;
    this.outlineBtn.classList.toggle('active', has && this.outlineOpen);
    const show = has && this.outlineOpen;
    this.outlinePanel.classList.toggle('open', show);
    // Like Google Docs: the page moves over to make room instead of being covered.
    if (ed.root.classList.contains('has-outline') !== show) { ed.root.classList.toggle('has-outline', show); ed.relayout(); }
    if (!show) return;
    const p = this.outlinePanel;
    p.replaceChildren();
    const head = h('div', 'ol-head', `<span>Outline</span>${ed.meta.outlineDetected ? '<small title="Found from the PDF’s headings">detected</small>' : ''}`);
    head.append(this.btn(icons.close, 'Hide outline', () => this.toggleOutline(false), 'icon-btn small'));
    p.append(head);
    const list = h('div', 'ol-list');
    for (const e of entries) {
      const b = h('button', `ol-item lvl${Math.min(e.level, 3)}`, `<span class="ol-title">${esc(e.title)}</span>`);
      b.dataset.page = e.page;
      b.title = `${e.title} — page ${ed.pages.indexOf(ed.pageView(e.page)!) + 1}`;
      b.onclick = () => { const pv = ed.pageView(e.page); if (pv) ed.scrollToPage(pv); if (window.innerWidth < 760) this.toggleOutline(false); };
      list.append(b);
    }
    p.append(list);
    this.markOutline();
  }

  private readingOutline = false;

  /**
   * Read a scanned PDF's table of contents with Inkly and use it as the
   * outline. `auto` runs once after import; otherwise it's from the menu.
   */
  async readScannedOutline(auto: boolean) {
    const ed = this.ed;
    if (this.readingOutline) return;
    this.readingOutline = true;
    ed.meta.outlinePending = false;
    const st = ed.doc.state;
    // Only the PDF pages, in order (a note can also have plain pages).
    const pages = st.pages.filter((p) => p.bg);
    try {
      const { entries, problem } = await findOutlineWithAI(pages, (s) => toast(s, 8000));
      if (entries.length) {
        ed.meta.outline = entries;
        ed.meta.outlineDetected = true;
        this.outlineOpen = true;
        this.renderOutline();
        toast(`Outline ready: ${entries.length} section${entries.length === 1 ? '' : 's'} from the table of contents`);
      } else if (!auto || problem) {
        toast(problem ?? 'No table of contents found.', 6000);
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      toast(code === 'passcode' ? 'Inkly needs its passcode first — open Ask Inkly and enter it.' : code === 'rate_limited' ? 'Inkly is out of credits for now.' : 'Couldn’t read the table of contents. Try again from the ⋯ menu.', 6000);
    } finally {
      this.readingOutline = false;
      ed.saveMeta();
    }
  }

  /** Highlight the section containing the page you're looking at. */
  private markOutline() {
    if (!this.outlinePanel.classList.contains('open')) return;
    const ed = this.ed;
    const cur = ed.pages.indexOf(ed.currentPage());
    let active: HTMLElement | null = null;
    for (const el of this.outlinePanel.querySelectorAll<HTMLElement>('.ol-item')) {
      const pv = ed.pageView(el.dataset.page ?? '');
      if (pv && ed.pages.indexOf(pv) <= cur) active = el;
      el.classList.remove('current');
    }
    if (active) {
      active.classList.add('current');
      const list = active.parentElement!;
      const r = active.offsetTop - list.clientHeight / 2;
      if (active.offsetTop < list.scrollTop || active.offsetTop > list.scrollTop + list.clientHeight - 30) list.scrollTo({ top: r, behavior: 'smooth' });
    }
  }

  private renderThumbs() {
    const ed = this.ed;
    const list = this.pagesPanel.querySelector('.pp-list')!;
    const st = ed.doc.state;
    const cur = ed.currentPage()?.page.id;
    for (const c of list.querySelectorAll('canvas')) c.width = c.height = 0;
    list.innerHTML = '';
    st.pages.forEach((p, i) => {
      const item = h('div', `pp-item${p.id === cur ? ' on' : ''}`);
      item.dataset.page = p.id;
      const frame = h('div', 'pp-thumb');
      frame.append(renderPageToCanvas(p, st.objectsOn(p.id), 260 / p.w));
      const more = this.btn(icons.more, `Page ${i + 1} options`, (b) => {
        menu([
          { label: 'Insert page after', icon: icons.plus, action: () => ed.doc.commit([{ t: 'addPage', page: newPage(p), after: p.id }]) },
          { label: 'Delete page', icon: icons.trash, danger: true, action: async () => {
            if (ed.doc.state.pages.length < 2) { toast('A note needs at least one page'); return; }
            if (await confirmBox(`Delete page ${i + 1}?`, 'You can undo this.')) ed.doc.commit([{ t: 'removePage', id: p.id }]);
          } },
        ], b, `Page ${i + 1}`);
      }, 'icon-btn small pp-more');
      item.append(frame, h('span', 'pp-num', String(i + 1)), more);
      item.onclick = (e) => {
        if ((e.target as HTMLElement).closest('.pp-more')) return;
        const pv = ed.pageView(p.id);
        if (pv) ed.scrollToPage(pv);
        if (window.innerWidth < 760) this.togglePages(false);
      };
      list.append(item);
    });
  }

  // ---------------------------------------------------------------- page badge

  showPageBadge() {
    const ed = this.ed;
    if (!ed.pages.length) return;
    const curPv = ed.currentPage();
    this.pageBadge.textContent = `${ed.pages.indexOf(curPv) + 1} / ${ed.pages.length}`;
    this.pageBadge.classList.add('show');
    clearTimeout(this.badgeTimer);
    this.badgeTimer = window.setTimeout(() => this.pageBadge.classList.remove('show'), 1100);
    if (this.pagesPanel.classList.contains('open')) {
      for (const el of this.pagesPanel.querySelectorAll<HTMLElement>('.pp-item')) el.classList.toggle('on', el.dataset.page === curPv.page.id);
    }
    this.markOutline();
  }

  // ---------------------------------------------------------------- menus

  private insertMenu(anchor: HTMLElement) {
    const ed = this.ed;
    menu([
      { label: 'Photo or image', icon: icons.image, action: async () => { const f = await pickFile('image/*'); if (f) ed.insertImage(f); } },
      { label: 'Take photo', icon: icons.camera, action: async () => { const f = await pickFile('image/*', true); if (f) ed.insertImage(f); } },
      { label: 'Sticky note', icon: icons.notes, action: () => ed.addSticky() },
      { label: 'Table', icon: icons.table, action: () => ed.tables.add() },
      { label: 'PDF pages', icon: icons.upload, action: async () => { const f = await pickFile('application/pdf,.pdf'); if (f) this.insertPdf(f); } },
      null,
      { label: 'Blank page after this one', icon: icons.page, action: () => {
        const cur = ed.currentPage();
        ed.doc.commit([{ t: 'addPage', page: newPage(cur.page), after: cur.page.id }]);
        const next = ed.pages[ed.pages.indexOf(ed.pageView(cur.page.id)!) + 1];
        if (next) ed.scrollToPage(next);
      } },
      ...(hasClipboard() ? [{ label: 'Paste', icon: icons.copy, action: () => ed.pasteHere() }] : []),
      { label: 'Paste text (match formatting)', icon: icons.textT, action: async () => {
        try { ed.pasteText(await navigator.clipboard.readText()); }
        catch { toast('Couldn’t read the clipboard here — press ⌘V / Ctrl+V on the page instead'); }
      } },
    ], anchor, 'Insert');
  }

  private moreMenu(anchor: HTMLElement) {
    const ed = this.ed;
    menu([
      { label: 'Quick export (PDF)', icon: icons.share, action: () => this.runExport({ format: 'pdf', background: true, range: 'all' }) },
      { label: 'Export options…', icon: icons.download, action: () => this.exportSheet() },
      null,
      { label: 'Paper for this note…', icon: icons.page, action: () => this.paperSheet() },
      { label: 'Delete this page', icon: icons.trash, danger: true, action: async () => {
        if (ed.pages.length < 2) { toast('A note needs at least one page'); return; }
        const cur = ed.currentPage();
        if (await confirmBox('Delete this page?', 'You can undo this.')) ed.doc.commit([{ t: 'removePage', id: cur.page.id }]);
      } },
      { label: 'Fit to width', icon: icons.pages, action: () => ed.fitWidth() },
      ...(ed.doc.state.pages.some((p) => p.bg) ? [{ label: 'Find table of contents with Inkly', icon: icons.inkly, action: () => this.readScannedOutline(false) }] : []),
      ...(inClaude ? [] : [
        { label: 'Copy link to this note', icon: icons.share, action: () => this.copyLink(false) },
        { label: 'Copy link to this page', icon: icons.page, action: () => this.copyLink(true) },
      ]),
      { label: 'Customize toolbar…', icon: icons.menu, action: () => this.customizeSheet() },
      null,
      { label: 'Settings', icon: icons.gear, action: () => openSettings(() => this.update()) },
    ], anchor);
  }

  /** Deep link that opens this note (optionally at this page) — e.g. from Notion, Reminders or a calendar. */
  private copyLink(page: boolean) {
    const ed = this.ed;
    const n = ed.pages.indexOf(ed.currentPage()) + 1;
    const url = `${location.origin}${location.pathname}#/note/${ed.meta.id}${page ? `/p${n}` : ''}`;
    navigator.clipboard?.writeText(url)
      .then(() => toast(page ? `Link to page ${n} copied` : 'Link to note copied'))
      .catch(() => toast(url, 8000));
  }

  async insertPdf(file: File) {
    const b = busy('Importing PDF…');
    try {
      const { pages, outline, detected } = await pdfToPages(file, (d, t) => b.set(`Importing page ${Math.min(d + 1, t)} of ${t}…`));
      if (outline.length) {
        this.ed.meta.outline = [...(this.ed.meta.outline ?? []), ...outline];
        if (detected) this.ed.meta.outlineDetected = true;
        this.ed.saveMeta();
      } else if (!this.ed.meta.outline?.length) {
        // Scanned PDF: read its table of contents with Inkly once the pages are in.
        setTimeout(() => this.readScannedOutline(true), 300);
      }
      const after = this.ed.currentPage().page.id;
      const ops: Op[] = [];
      let prev = after;
      for (const p of pages) { ops.push({ t: 'addPage', page: p, after: prev }); prev = p.id; }
      this.ed.doc.commit(ops);
      const first = this.ed.pageView(pages[0]?.id ?? '');
      if (first) this.ed.scrollToPage(first);
      toast(`Inserted ${pages.length} page${pages.length === 1 ? '' : 's'}${outline.length ? ` · outline with ${outline.length} sections` : ''}`);
      this.renderOutline();
    } catch (e) {
      console.error(e);
      toast('Could not read that PDF');
    } finally { b.done(); }
  }

  private exportSheet() {
    const o: ExportChoice = { format: 'pdf', background: true, range: 'all' };
    sheet((box, close) => {
      const head = h('div', 'pop-head');
      const cancel = h('button', 'link-btn', 'Cancel');
      const go = h('button', 'link-btn strong', 'Export');
      cancel.onclick = close;
      go.onclick = () => { close(); this.runExport(o); };
      head.append(cancel, h('b', '', 'Export options'), go);
      const body = h('div');
      const render = () => {
        body.innerHTML = '';
        body.append(h('div', 'set-caption', 'File format'));
        const fmtSeg = h('div', 'segmented wide');
        for (const [v, l] of [['pdf', 'PDF'], ['note', 'Inkwell note']] as const) {
          const b = h('button', o.format === v ? 'on' : '', l);
          b.onclick = () => { o.format = v; render(); };
          fmtSeg.append(b);
        }
        const g1 = h('div', 'set-group pad');
        g1.append(fmtSeg);
        body.append(g1);
        if (o.format === 'pdf') {
          body.append(h('div', 'set-caption', 'More options'));
          const g = h('div', 'set-group');
          const r = h('label', 'set-row', '<span class="set-text"><span class="set-label">Include background paper</span><span class="set-desc">Lines, grid or dots and paper color</span></span>');
          const sw = h('input', 'switch');
          sw.type = 'checkbox';
          sw.checked = o.background;
          sw.onchange = () => { o.background = sw.checked; };
          r.append(sw);
          const pr = h('div', 'set-row', '<span class="set-text"><span class="set-label">Page range</span></span>');
          const seg = h('div', 'segmented');
          for (const [v, l] of [['all', 'All'], ['current', 'This page']] as const) {
            const b = h('button', o.range === v ? 'on' : '', l);
            b.onclick = () => { o.range = v; render(); };
            seg.append(b);
          }
          pr.append(seg);
          g.append(r, pr);
          body.append(g);
        } else {
          body.append(h('p', 'set-note', 'A complete copy — ink, text, images, PDFs and audio — that you can import on another device.'));
        }
      };
      render();
      box.append(head, body);
    }, undefined, 'sheet-md');
  }

  private async runExport(o: ExportChoice) {
    const ed = this.ed;
    await ed.flush();
    if (o.format === 'note') {
      try { await saveBlob(await exportNoteFile(ed.meta), `${safeName(ed.meta.title)}.inkwell`); }
      catch (e) { console.error(e); toast('Export failed'); }
      return;
    }
    const b = busy('Preparing PDF…');
    try {
      const blob = await exportPdf(ed.meta.title, ed.doc.state, (d, t) => b.set(`Rendering page ${d + 1} of ${t}…`), {
        background: o.background, pageIds: o.range === 'current' ? [ed.currentPage().page.id] : undefined,
      });
      b.done();
      await saveBlob(blob, `${safeName(ed.meta.title)}.pdf`);
    } catch (e) {
      console.error(e);
      b.done();
      toast('PDF export failed');
    }
  }

  private paperSheet() {
    const ed = this.ed;
    sheet((box, close) => {
      const head = h('div', 'pop-head', '<span></span><b>Paper</b>');
      const done = h('button', 'link-btn', 'Done');
      done.onclick = close;
      head.append(done);
      const body = h('div');
      box.append(head, body);
      const apply = (patch: { template?: Template; paper?: string }) => {
        ed.doc.commit(ed.doc.state.pages.filter((p) => !p.bg).map((p): Op => ({ t: 'updatePage', id: p.id, patch })));
        render();
      };
      const render = () => {
        body.innerHTML = '';
        const page = ed.currentPage().page;
        body.append(h('div', 'set-caption', 'Template — all pages'));
        const g = h('div', 'set-group pad');
        const row = h('div', 'paper-row');
        for (const [t, label] of [['blank', 'Blank'], ['lined', 'Lined'], ['grid', 'Grid'], ['dotted', 'Dotted']] as [Template, string][]) {
          const b = h('button', `paper-opt${page.template === t ? ' on' : ''}`, `<span class="paper-prev ${t}" style="--paper:${page.paper}"></span>${label}`);
          b.onclick = () => apply({ template: t });
          row.append(b);
        }
        const crow = h('div', 'paper-row');
        for (const c of PAPER_COLORS) {
          const b = h('button', `swatch big${page.paper === c ? ' on' : ''}`);
          b.style.setProperty('--c', c);
          b.setAttribute('aria-label', `Paper ${c}`);
          b.onclick = () => apply({ paper: c });
          crow.append(b);
        }
        g.append(row, h('div', 'set-sub', 'Color'), crow);
        body.append(g);
      };
      render();
    }, undefined, 'sheet-md');
  }
}
