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
import { HL_COLORS, PAPER_COLORS, PEN_COLORS, saveSettings, settings, type ToolName } from './settings';
import { hasClipboard } from './tools';
import { db } from '../persist/db';
import { InklyPanel } from './inkly';
import { Recorder } from './audio';

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

function pickFile(accept: string, capture = false): Promise<File | null> {
  return new Promise((resolve) => {
    const i = h('input');
    i.type = 'file';
    i.accept = accept;
    if (capture) i.setAttribute('capture', 'environment');
    i.onchange = () => resolve(i.files?.[0] ?? null);
    i.click();
  });
}

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

    const tools = h('div', 'dock-tools');
    for (const t of TOOLS) {
      const b = this.btn(`${t.icon}<span class="ink-dot"></span>`, t.label, () => ed.setTool(t.name), 'icon-btn tool-btn');
      this.toolBtns.set(t.name, b);
      tools.append(b);
    }
    tools.append(this.btn(icons.insert, 'Insert', (b) => this.insertMenu(b), 'icon-btn tool-btn'));
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
    if (!Recorder.supported()) this.recBtn.hidden = true;
    tools.append(this.recBtn, h('span', 'vsep'), this.handBtn, collapse);
    this.dock.append(tools, this.opts);

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
    const key = JSON.stringify([tool, settings.pen, settings.highlighter, settings.eraser, settings.text, settings.lassoMode, this.ed.playT != null, hasClipboard(), settings.recentColors]);
    if (key === this.optsKey) return;
    this.optsKey = key;
    const s = this.opts;
    s.innerHTML = '';
    if (this.ed.playT != null) {
      s.append(h('span', 'strip-hint', 'Playback — tap any writing to hear that moment'));
      return;
    }
    const save = () => { saveSettings(); this.update(); };
    if (tool === 'pen' || tool === 'shape') {
      // Notability order: colors, then sizes.
      this.colors(s, PEN_COLORS, settings.pen.color, (c) => { settings.pen.color = c; save(); });
      s.append(h('span', 'vsep'));
      this.sizes(s, settings.penWidths, settings.pen.width, (w) => { settings.pen.width = w; save(); });
    } else if (tool === 'highlighter') {
      this.colors(s, HL_COLORS, settings.highlighter.color, (c) => { settings.highlighter.color = c; save(); });
      s.append(h('span', 'vsep'));
      this.sizes(s, settings.hlWidths, settings.highlighter.width, (w) => { settings.highlighter.width = w; save(); });
    } else if (tool === 'eraser') {
      this.sizes(s, ERASER_SIZES, settings.eraser.size, (w) => { settings.eraser.size = w; save(); });
      s.append(h('span', 'vsep'));
      s.append(
        this.chip(icons.whole, 'Whole', settings.eraser.mode === 'stroke', () => { settings.eraser.mode = 'stroke'; save(); }),
        this.chip(icons.partial, 'Partial', settings.eraser.mode === 'partial', () => { settings.eraser.mode = 'partial'; save(); }),
        this.chip(icons.highlighter, 'Highlights only', settings.eraser.highlighterOnly, () => { settings.eraser.highlighterOnly = !settings.eraser.highlighterOnly; save(); }),
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
  }

  // ---------------------------------------------------------------- menus

  private insertMenu(anchor: HTMLElement) {
    const ed = this.ed;
    menu([
      { label: 'Photo or image', icon: icons.image, action: async () => { const f = await pickFile('image/*'); if (f) ed.insertImage(f); } },
      { label: 'Take photo', icon: icons.camera, action: async () => { const f = await pickFile('image/*', true); if (f) ed.insertImage(f); } },
      { label: 'PDF pages', icon: icons.upload, action: async () => { const f = await pickFile('application/pdf,.pdf'); if (f) this.insertPdf(f); } },
      null,
      { label: 'Blank page after this one', icon: icons.page, action: () => {
        const cur = ed.currentPage();
        ed.doc.commit([{ t: 'addPage', page: newPage(cur.page), after: cur.page.id }]);
        const next = ed.pages[ed.pages.indexOf(ed.pageView(cur.page.id)!) + 1];
        if (next) ed.scrollToPage(next);
      } },
      ...(hasClipboard() ? [{ label: 'Paste', icon: icons.copy, action: () => ed.pasteHere() }] : []),
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
      null,
      { label: 'Settings', icon: icons.gear, action: () => openSettings(() => this.update()) },
    ], anchor);
  }

  async insertPdf(file: File) {
    const b = busy('Importing PDF…');
    try {
      const pages = await pdfToPages(file, (d, t) => b.set(`Importing page ${Math.min(d + 1, t)} of ${t}…`));
      const after = this.ed.currentPage().page.id;
      const ops: Op[] = [];
      let prev = after;
      for (const p of pages) { ops.push({ t: 'addPage', page: p, after: prev }); prev = p.id; }
      this.ed.doc.commit(ops);
      const first = this.ed.pageView(pages[0]?.id ?? '');
      if (first) this.ed.scrollToPage(first);
      toast(`Inserted ${pages.length} page${pages.length === 1 ? '' : 's'}`);
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
