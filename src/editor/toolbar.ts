// Editor chrome: top bar, contextual tool strip, selection menu, playback bar.
import type { Op, Template } from '../model/types';
import { icons } from '../ui/icons';
import { busy, confirmBox, esc, menu, panel, toast } from '../ui/modal';
import type { Editor } from './editor';
import { newPage } from './editor';
import { exportNoteFile, exportPdf, pdfToPages, safeName, saveBlob } from './io';
import { HL_COLORS, PAPER_COLORS, PEN_COLORS, saveSettings, settings, type ToolName } from './settings';
import { hasClipboard } from './tools';
import { db } from '../persist/db';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

const TOOLS: { name: ToolName; icon: string; label: string }[] = [
  { name: 'pen', icon: icons.pen, label: 'Pen (P)' },
  { name: 'highlighter', icon: icons.highlighter, label: 'Highlighter (H)' },
  { name: 'eraser', icon: icons.eraser, label: 'Eraser (E)' },
  { name: 'lasso', icon: icons.lasso, label: 'Lasso (L)' },
  { name: 'shape', icon: icons.shape, label: 'Shapes (S)' },
  { name: 'text', icon: icons.text, label: 'Text (T)' },
];

const fmt = (t: number) => {
  t = Math.max(0, Math.floor(t));
  const hh = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (hh ? `${hh}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
};

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const i = h('input');
    i.type = 'file';
    i.accept = accept;
    i.onchange = () => resolve(i.files?.[0] ?? null);
    i.click();
  });
}

export class Toolbar {
  readonly el = h('div', 'ed-chrome');
  readonly selMenu = h('div', 'sel-menu');
  readonly playbar = h('div', 'playbar');
  readonly pageBadge = h('div', 'page-badge');
  private bar = h('header', 'ed-bar');
  private strip = h('div', 'ed-strip');
  private toolBtns = new Map<ToolName, HTMLButtonElement>();
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private recBtn!: HTMLButtonElement;
  private recTimer = 0;
  private badgeTimer = 0;
  private scrub!: HTMLInputElement;
  private timeLbl!: HTMLSpanElement;
  private playBtn!: HTMLButtonElement;
  private stripKey = '';

  constructor(private ed: Editor) {
    this.buildBar();
    this.buildPlaybar();
    this.el.append(this.bar, this.strip);
    this.renderStrip();
  }

  private btn(icon: string, label: string, onClick: (b: HTMLButtonElement) => void, cls = 'icon-btn') {
    const b = h('button', cls, icon);
    b.title = label;
    b.setAttribute('aria-label', label);
    b.onclick = () => onClick(b);
    return b;
  }

  private buildBar() {
    const ed = this.ed;
    const left = h('div', 'bar-left');
    left.append(this.btn(icons.back, 'Library', () => ed.onExit()));
    const title = h('input', 'title-input');
    title.value = ed.meta.title;
    title.setAttribute('aria-label', 'Note title');
    title.onchange = () => { ed.meta.title = title.value.trim() || 'Untitled note'; title.value = ed.meta.title; ed.saveMeta(); };
    title.onkeydown = (e) => { if (e.key === 'Enter') title.blur(); };
    left.append(title);

    const mid = h('div', 'bar-tools');
    this.undoBtn = this.btn(icons.undo, 'Undo', () => ed.doc.undo());
    this.redoBtn = this.btn(icons.redo, 'Redo', () => ed.doc.redo());
    mid.append(this.undoBtn, this.redoBtn, h('span', 'sep'));
    for (const t of TOOLS) {
      const b = this.btn(t.icon, t.label, () => ed.setTool(t.name), 'icon-btn tool-btn');
      this.toolBtns.set(t.name, b);
      mid.append(b);
    }
    mid.append(this.btn(icons.image, 'Insert image', async () => {
      const f = await pickFile('image/*');
      if (f) ed.insertImage(f);
    }));

    const right = h('div', 'bar-right');
    this.recBtn = this.btn(icons.mic, 'Record audio', () => ed.toggleRecord(), 'icon-btn rec-btn');
    right.append(this.recBtn, this.btn(icons.more, 'More', (b) => this.moreMenu(b)));
    this.bar.append(left, mid, right);
  }

  update() {
    const ed = this.ed;
    for (const [n, b] of this.toolBtns) b.classList.toggle('active', settings.tool === n);
    this.undoBtn.disabled = !ed.doc.canUndo;
    this.redoBtn.disabled = !ed.doc.canRedo;
    const rec = ed.recorder.active;
    this.recBtn.classList.toggle('recording', rec);
    clearInterval(this.recTimer);
    if (rec) {
      const tick = () => { this.recBtn.innerHTML = `<span class="rec-dot"></span><span class="rec-time">${fmt(ed.recorder.elapsed())}</span>`; };
      tick();
      this.recTimer = window.setInterval(tick, 500);
    } else this.recBtn.innerHTML = icons.mic;
    this.renderStrip();
    this.updatePlaybar();
  }

  // ---------------------------------------------------------------- tool strip

  renderStrip() {
    const tool = settings.tool;
    const key = JSON.stringify([tool, settings.pen, settings.highlighter, settings.eraser, settings.text, this.ed.playT != null, hasClipboard()]);
    if (key === this.stripKey) return;
    this.stripKey = key;
    const s = this.strip;
    s.innerHTML = '';
    if (this.ed.playT != null) {
      s.append(h('span', 'strip-hint', 'Playback — tap any writing to hear what was said at that moment.'));
      return;
    }
    const save = () => { saveSettings(); this.stripKey = ''; this.renderStrip(); };
    if (tool === 'pen' || tool === 'shape') {
      this.colors(s, PEN_COLORS, settings.pen.color, (c) => { settings.pen.color = c; save(); });
      s.append(h('span', 'sep'));
      this.widths(s, settings.penWidths, settings.pen.width, settings.pen.color, (w) => { settings.pen.width = w; save(); });
      if (tool === 'pen') {
        s.append(h('span', 'sep'));
        s.append(this.toggle('Pressure', settings.pen.pressure, (v) => { settings.pen.pressure = v; save(); }));
      } else s.append(h('span', 'strip-hint', 'Draw roughly — it snaps to a clean shape'));
    } else if (tool === 'highlighter') {
      this.colors(s, HL_COLORS, settings.highlighter.color, (c) => { settings.highlighter.color = c; save(); });
      s.append(h('span', 'sep'));
      this.widths(s, settings.hlWidths, settings.highlighter.width, settings.highlighter.color, (w) => { settings.highlighter.width = w; save(); }, 0.6);
    } else if (tool === 'eraser') {
      const seg = h('div', 'segmented');
      for (const [m, label] of [['partial', 'Partial'], ['stroke', 'Whole stroke']] as const) {
        const b = h('button', settings.eraser.mode === m ? 'on' : '', label);
        b.onclick = () => { settings.eraser.mode = m; save(); };
        seg.append(b);
      }
      s.append(seg, h('span', 'sep'));
      s.append(this.toggle('Highlighter only', settings.eraser.highlighterOnly, (v) => { settings.eraser.highlighterOnly = v; save(); }));
      s.append(h('span', 'sep'));
      const size = h('input', 'slider');
      size.type = 'range'; size.min = '6'; size.max = '64'; size.value = String(settings.eraser.size);
      size.oninput = () => { settings.eraser.size = +size.value; saveSettings(); };
      const lab = h('label', 'strip-label', 'Size');
      lab.append(size);
      s.append(lab);
    } else if (tool === 'lasso') {
      s.append(h('span', 'strip-hint', 'Circle items to select them, or tap one. Drag to move; drag the corner dot to resize.'));
      if (hasClipboard()) {
        const p = h('button', 'pill', 'Paste');
        p.onclick = () => this.ed.pasteHere();
        s.append(p);
      }
    } else if (tool === 'text') {
      const t = settings.text;
      const apply = () => { this.ed.text.applyStyle(); save(); };
      const font = h('select', 'select');
      for (const [v, l] of [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono'], ['hand', 'Handwritten']]) {
        const o = h('option', '', l); o.value = v; font.append(o);
      }
      font.value = t.font;
      font.onchange = () => { t.font = font.value as typeof t.font; apply(); };
      // Keep focus in the text box while using these controls.
      const keep = (b: HTMLElement) => { b.onpointerdown = (e) => e.preventDefault(); return b; };
      const minus = keep(h('button', 'pill', 'A−'));
      minus.onclick = () => { t.size = Math.max(8, t.size - 2); apply(); };
      const sz = h('span', 'strip-label', `${t.size}pt`);
      const plus = keep(h('button', 'pill', 'A+'));
      plus.onclick = () => { t.size = Math.min(96, t.size + 2); apply(); };
      const bold = keep(h('button', `pill${t.bold ? ' on' : ''}`, '<b>B</b>'));
      bold.onclick = () => { t.bold = !t.bold; apply(); };
      s.append(font, minus, sz, plus, bold, h('span', 'sep'));
      this.colors(s, PEN_COLORS, t.color, (c) => { t.color = c; apply(); }, true);
      s.append(h('span', 'strip-hint', 'Tap the page to type'));
    }
  }

  private colors(s: HTMLElement, list: string[], current: string, set: (c: string) => void, keepFocus = false) {
    const all = [...new Set([...list, ...settings.recentColors.filter((c) => !list.includes(c)).slice(0, 2)])];
    for (const c of all) {
      const b = h('button', `swatch${c.toLowerCase() === current.toLowerCase() ? ' on' : ''}`);
      b.style.setProperty('--c', c);
      b.title = c;
      if (keepFocus) b.onpointerdown = (e) => e.preventDefault();
      b.onclick = () => set(c);
      s.append(b);
    }
    const custom = h('label', 'swatch custom', '+');
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

  private widths(s: HTMLElement, list: number[], current: number, color: string, set: (w: number) => void, dotScale = 1) {
    for (const w of list) {
      const b = h('button', `width-btn${Math.abs(w - current) < 0.01 ? ' on' : ''}`);
      const d = h('span', 'width-dot');
      const px = Math.max(3, Math.min(20, w * 2.2 * dotScale));
      Object.assign(d.style, { width: `${px}px`, height: `${px}px`, background: color });
      b.append(d);
      b.title = `${w}pt`;
      b.onclick = () => set(w);
      s.append(b);
    }
  }

  private toggle(label: string, value: boolean, set: (v: boolean) => void) {
    const b = h('button', `pill${value ? ' on' : ''}`, esc(label));
    b.onclick = () => set(!value);
    return b;
  }

  // ---------------------------------------------------------------- selection menu

  showSelMenu() {
    const lasso = this.ed.tools.lasso;
    if (!lasso.sel) return this.hideSelMenu();
    const m = this.selMenu;
    m.innerHTML = '';
    const act = (icon: string, label: string, fn: () => void, cls = '') => {
      const b = h('button', `sel-btn ${cls}`, `${icon}<span>${label}</span>`);
      b.onclick = fn;
      m.append(b);
    };
    act(icons.trash, 'Delete', () => lasso.remove(), 'danger');
    act(icons.duplicate, 'Duplicate', () => lasso.duplicate());
    act(icons.copy, 'Copy', () => { lasso.copy(); toast('Copied'); this.renderStrip(); });
    const objs = lasso.objects();
    if (objs.some((o) => o.kind !== 'image')) {
      m.append(h('span', 'sep'));
      for (const c of PEN_COLORS.slice(0, 5)) {
        const b = h('button', 'swatch small');
        b.style.setProperty('--c', c);
        b.onclick = () => lasso.recolor(c);
        m.append(b);
      }
    }
    if (objs.length === 1 && objs[0].kind === 'text') {
      const id = objs[0].id;
      act(icons.text, 'Edit', () => { this.ed.setTool('text'); this.ed.text.edit(id); });
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
    if (top < vr.top + 6) top = Math.min(r.y + r.h + 18, vr.bottom - mh - 6);
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
    this.scrub.oninput = () => { const p = ed.ensurePlayer(); p.seek(+this.scrub.value); };
    const rate = h('button', 'pill rate', '1×');
    rate.onclick = () => {
      const p = ed.ensurePlayer();
      const next = p.rate === 1 ? 1.5 : p.rate === 1.5 ? 2 : p.rate === 2 ? 0.75 : 1;
      p.setRate(next);
      rate.textContent = `${next}×`;
    };
    const close = this.btn(icons.close, 'Exit playback', () => ed.exitReplay(), 'icon-btn play-close');
    const clips = this.btn(icons.waveform, 'Recordings', () => this.recordingsPanel());
    this.playbar.append(this.playBtn, this.timeLbl, this.scrub, rate, clips, close);
  }

  private updatePlaybar() {
    const ed = this.ed;
    const has = ed.meta.clips.length > 0 && !ed.recorder.active;
    this.playbar.classList.toggle('show', has);
    this.playbar.classList.toggle('replay', ed.playT != null);
    this.ed.root.classList.toggle('has-playbar', has);
    const playing = !!ed.player?.playing;
    this.playBtn.innerHTML = playing ? icons.pause : icons.play;
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

  private recordingsPanel() {
    const ed = this.ed;
    panel('Recordings', (body, close) => {
      if (!ed.meta.clips.length) { body.append(h('p', 'muted', 'No recordings yet.')); return; }
      ed.meta.clips.forEach((c, i) => {
        const row = h('div', 'clip-row');
        row.append(h('span', '', `Recording ${i + 1}`), h('span', 'muted', `${fmt(c.duration)} · starts at ${fmt(c.start)}`));
        const play = h('button', 'pill', 'Play');
        play.onclick = () => { close(); const p = ed.ensurePlayer(); p.seek(c.start).then(() => p.play()); };
        const del = h('button', 'pill danger', 'Delete');
        del.onclick = async () => {
          if (!(await confirmBox('Delete recording?', 'The audio is removed. Your notes stay.'))) return;
          ed.exitReplay();
          ed.meta.clips = ed.meta.clips.filter((x) => x !== c);
          if (ed.player) ed.player.clips = ed.meta.clips;
          await db.deleteAudio(c.id);
          await ed.saveMeta();
          close();
          ed.toolbar.update();
        };
        row.append(play, del);
        body.append(row);
      });
    });
  }

  // ---------------------------------------------------------------- page badge

  showPageBadge() {
    const ed = this.ed;
    if (!ed.pages.length) return;
    const cur = ed.pages.indexOf(ed.currentPage()) + 1;
    this.pageBadge.textContent = `${cur} / ${ed.pages.length}`;
    this.pageBadge.classList.add('show');
    clearTimeout(this.badgeTimer);
    this.badgeTimer = window.setTimeout(() => this.pageBadge.classList.remove('show'), 1100);
  }

  // ---------------------------------------------------------------- more menu

  private moreMenu(anchor: HTMLElement) {
    const ed = this.ed;
    menu([
      { label: 'Paper…', icon: icons.page, action: () => this.paperPanel() },
      { label: 'Add page after this one', icon: icons.plus, action: () => {
        const cur = ed.currentPage();
        ed.doc.commit([{ t: 'addPage', page: newPage(cur.page), after: cur.page.id }]);
        const next = ed.pages[ed.pages.indexOf(ed.pageView(cur.page.id)!) + 1];
        if (next) ed.scrollToPage(next);
      } },
      { label: 'Delete this page', icon: icons.trash, danger: true, action: async () => {
        if (ed.pages.length < 2) { toast('A note needs at least one page'); return; }
        const cur = ed.currentPage();
        if (await confirmBox('Delete this page?', 'You can undo this.')) ed.doc.commit([{ t: 'removePage', id: cur.page.id }]);
      } },
      null,
      { label: 'Insert PDF pages…', icon: icons.upload, action: async () => { const f = await pickFile('application/pdf,.pdf'); if (f) this.insertPdf(f); } },
      ...(hasClipboard() ? [{ label: 'Paste', icon: icons.copy, action: () => ed.pasteHere() }] : []),
      null,
      { label: 'Export as PDF', icon: icons.download, action: () => this.exportPdf() },
      { label: 'Export note file (.inkwell)', icon: icons.download, action: async () => {
        await ed.flush();
        try { await saveBlob(await exportNoteFile(ed.meta), `${safeName(ed.meta.title)}.inkwell`); }
        catch (e) { console.error(e); toast('Export failed'); }
      } },
      null,
      { label: 'Draw with finger', checked: settings.fingerDraw, action: () => { settings.fingerDraw = !settings.fingerDraw; saveSettings(); toast(settings.fingerDraw ? 'One finger draws; two fingers scroll' : 'Fingers scroll; draw with pencil or mouse'); } },
      { label: 'Hold to snap shapes', checked: settings.holdToSnap, action: () => { settings.holdToSnap = !settings.holdToSnap; saveSettings(); } },
      { label: 'Fit to width', action: () => ed.fitWidth() },
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

  private async exportPdf() {
    const ed = this.ed;
    ed.text.finish();
    const b = busy('Preparing PDF…');
    try {
      const blob = await exportPdf(ed.meta.title, ed.doc.state, (d, t) => b.set(`Rendering page ${d + 1} of ${t}…`));
      b.done();
      await saveBlob(blob, `${safeName(ed.meta.title)}.pdf`);
    } catch (e) {
      console.error(e);
      b.done();
      toast('PDF export failed');
    }
  }

  private paperPanel() {
    const ed = this.ed;
    panel('Paper', (body) => {
      const templates: [Template, string][] = [['blank', 'Blank'], ['lined', 'Lined'], ['grid', 'Grid'], ['dotted', 'Dotted']];
      const apply = (patch: { template?: Template; paper?: string }) => {
        const ops: Op[] = ed.doc.state.pages.filter((p) => !p.bg).map((p) => ({ t: 'updatePage', id: p.id, patch }));
        ed.doc.commit(ops);
        Object.assign(settings.paper, patch.template ? { template: patch.template } : {}, patch.paper ? { color: patch.paper } : {});
        saveSettings();
        render();
      };
      const render = () => {
        body.innerHTML = '';
        const page = ed.currentPage().page;
        body.append(h('div', 'panel-label', 'Template (all pages)'));
        const row = h('div', 'paper-row');
        for (const [t, label] of templates) {
          const b = h('button', `paper-opt${page.template === t ? ' on' : ''}`, `<span class="paper-prev ${t}" style="--paper:${page.paper}"></span>${label}`);
          b.onclick = () => apply({ template: t });
          row.append(b);
        }
        body.append(row, h('div', 'panel-label', 'Color'));
        const crow = h('div', 'paper-row');
        for (const c of PAPER_COLORS) {
          const b = h('button', `swatch big${page.paper === c ? ' on' : ''}`);
          b.style.setProperty('--c', c);
          b.onclick = () => apply({ paper: c });
          crow.append(b);
        }
        body.append(crow);
        const sz = h('div', 'panel-label', 'New notes use ');
        const sel = h('select', 'select');
        for (const [v, l] of [['letter', 'US Letter'], ['a4', 'A4']]) { const o = h('option', '', l); o.value = v; sel.append(o); }
        sel.value = settings.paper.size;
        sel.onchange = () => { settings.paper.size = sel.value as 'letter' | 'a4'; saveSettings(); };
        sz.append(sel);
        body.append(sz);
      };
      render();
    });
  }
}
