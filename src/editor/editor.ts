// The note editor: owns the document, camera, page views, input pipeline,
// persistence wiring and audio. Tools and UI hang off it.
import { Change, DocState, NoteDocument, objBounds, opOrder, applyOp } from '../model/doc';
import type { LoggedOp, NoteMeta, Op, OutlineEntry, Page, PageObject, Snapshot, StickyObj, TextObj } from '../model/types';
import { PAGE_SIZES } from '../model/types';
import type { Sample } from '../ink/stroke';
import { db } from '../persist/db';
import { PageView } from '../render/pageView';
import { isDark, renderPageToCanvas, type DrawOpts } from '../render/draw';
import { media, decode } from '../render/media';
import { inRect, intersects, type Pt, type Rect } from '../util/geom';
import { deviceId, uid } from '../util/ids';
import { toast } from '../ui/modal';
import { Player, Recorder, recoverClips, timelineEnd } from './audio';
import { settings, saveSettings, type ToolName } from './settings';
import { TextLayer } from './textLayer';
import { EraserTool, InkTool, LassoTool, OBJECTS_MARKER, TextTool, hitObject, type Tool } from './tools';
import { Toolbar } from './toolbar';

const GAP = 12;
/** Screen px kept clear above the first page for the floating toolbar. */
const TOP = 108;
const MIN_Z = 0.25, MAX_Z = 6;
const SNAPSHOT_EVERY = 250;

type Gesture =
  | { kind: 'pan'; id: number; x: number; y: number; vx: number; vy: number; t: number }
  | { kind: 'pinch'; d0: number; cx: number; cy: number; z0: number; tx0: number; ty0: number };

export function newPage(after?: Page): Page {
  const size = PAGE_SIZES[settings.paper.size];
  return {
    id: uid(), w: after && !after.bg ? after.w : size.w, h: after && !after.bg ? after.h : size.h,
    template: after && !after.bg ? after.template : settings.paper.template,
    paper: after && !after.bg ? after.paper : settings.paper.color,
  };
}

export async function createNote(folder: string | null, title = 'Untitled note', pages?: Page[], outline?: OutlineEntry[], outlineDetected = false): Promise<NoteMeta> {
  const now = Date.now();
  const meta: NoteMeta = { id: uid(), title, folder, created: now, modified: now, clips: [], ...(outline?.length ? { outline, ...(outlineDetected ? { outlineDetected } : {}) } : {}) };
  // A PDF with no readable outline: try reading its scanned table of contents when the note opens.
  if (pages?.some((p) => p.bg) && !outline?.length) meta.outlinePending = true;
  const ps = pages?.length ? pages : [newPage()];
  const snap: Snapshot = { pages: ps, objects: Object.fromEntries(ps.map((p) => [p.id, []])) };
  // Born as a snapshot (not ops) so the first page can't be undone away.
  await db.putSnapshot(meta.id, snap, 0);
  meta.pageCount = ps.length;
  await db.putNote(meta);
  return meta;
}

export class Editor {
  readonly root: HTMLDivElement;
  readonly viewport: HTMLDivElement;
  readonly world: HTMLDivElement;
  private overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;
  readonly toolbar: Toolbar;
  readonly text: TextLayer;

  pages: PageView[] = [];
  private pageMap = new Map<string, PageView>();
  cam = { z: 1, tx: 0, ty: 0 };
  private renderZ = 1;
  private zoomTimer = 0;
  private docW = 612;
  private docH = 800;
  private vw = 0;
  private vh = 0;
  /**
   * Canvas pixels per CSS pixel. Never below 2: on standard-density screens the
   * ink is supersampled and scaled down, which gives smooth, non-jagged edges.
   */
  dpr = Math.min(3, Math.max(2, window.devicePixelRatio || 1));

  readonly tools: { pen: InkTool; highlighter: InkTool; shape: InkTool; eraser: EraserTool; lasso: LassoTool; text: TextTool };
  tool: Tool;
  private hidden = new Set<string>();

  readonly recorder = new Recorder();
  player: Player | null = null;
  playT: number | null = null;
  private byTime: PageObject[] | null = null;

  private ptrs = new Map<number, Pt>();
  private ignored = new Set<number>();
  private drawId: number | null = null;
  private drawType = '';
  private gesture: Gesture | null = null;
  private tap: { id: number; x: number; y: number; t: number } | null = null;
  private inertia = 0;
  private spaceDown = false;
  private frame = 0;
  private opsSinceSnap = 0;
  private metaTimer = 0;
  private thumbTimer = 0;
  private unsubs: (() => void)[] = [];
  private closed = false;

  static async open(id: string, mount: HTMLElement, onExit: () => void, page?: number): Promise<Editor> {
    const meta = await db.getNote(id);
    if (!meta) throw new Error('Note not found');
    const { snap, ops } = await db.loadDoc(id);
    const state = snap ? DocState.fromSnapshot(snap.state) : new DocState();
    let lamport = snap?.lamport ?? 0;
    const ch = new Change();
    // Tail replay. A torn final write just isn't there: IndexedDB transactions are atomic.
    for (const e of ops.sort(opOrder)) { applyOp(state, e.op, ch); lamport = Math.max(lamport, e.lamport); }
    if (!state.pages.length) { const p = newPage(); state.pages.push(p); state.order.set(p.id, []); }
    const recovered = await recoverClips(id, meta.clips).catch(() => []);
    if (recovered.length) {
      meta.clips.push(...recovered);
      await db.putNote(meta);
      toast(`Recovered ${recovered.length} interrupted recording${recovered.length > 1 ? 's' : ''}`);
    }
    const doc = new NoteDocument(deviceId(), state, lamport);
    const ed = new Editor(meta, doc, mount, onExit);
    ed.opsSinceSnap = ops.length;
    // Deep link to a page (1-based).
    if (page && ed.pages[page - 1]) ed.scrollToPage(ed.pages[page - 1]);
    if (meta.outlinePending) setTimeout(() => ed.toolbar.readScannedOutline(true), 600);
    return ed;
  }

  private constructor(readonly meta: NoteMeta, readonly doc: NoteDocument, mount: HTMLElement, readonly onExit: () => void) {
    doc.clock = () => this.timeline();
    this.root = document.createElement('div');
    this.root.className = 'editor';
    this.viewport = document.createElement('div');
    this.viewport.className = 'viewport';
    this.world = document.createElement('div');
    this.world.className = 'world';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'overlay';
    // desynchronized: lets the browser present ink without waiting on the compositor (lower latency).
    this.octx = (this.overlay.getContext('2d', { desynchronized: true }) ?? this.overlay.getContext('2d'))!;
    this.viewport.append(this.world, this.overlay);
    this.text = new TextLayer(this);
    this.tools = {
      pen: new InkTool(this, 'pen'), highlighter: new InkTool(this, 'highlighter'), shape: new InkTool(this, 'shape'),
      eraser: new EraserTool(this), lasso: new LassoTool(this), text: new TextTool(this),
    };
    this.tool = this.tools[settings.tool];
    this.toolbar = new Toolbar(this);
    this.root.append(this.viewport, this.toolbar.el, this.toolbar.pagesPanel, this.toolbar.outlinePanel, this.toolbar.inkly.el, this.toolbar.selMenu, this.toolbar.playbar, this.toolbar.pageBadge);
    mount.append(this.root);
    this.root.classList.toggle('tool-text', settings.tool === 'text');
    this.root.classList.toggle('dot-cursor', ['pen', 'highlighter', 'shape', 'eraser'].includes(settings.tool));

    this.unsubs.push(doc.on((ch, logged) => this.onChange(ch, logged)));
    this.unsubs.push(media.onLoad((hash) => this.onMedia(hash)));
    this.bindInput();
    this.layoutPages();
    this.resize();
    this.restoreView();
    this.toolbar.update();
    this.toolbar.renderOutline();
  }

  // ------------------------------------------------------------ geometry

  private layoutPages() {
    const st = this.doc.state;
    const maxW = Math.max(...st.pages.map((p) => p.w));
    const side = this.stickySide();
    this.side = side;
    let y = 0;
    const next: PageView[] = [];
    const seen = new Set<string>();
    for (const p of st.pages) {
      let pv = this.pageMap.get(p.id);
      if (!pv) {
        pv = new PageView(p, () => this.doc.state, (pg) => this.drawOpts(pg));
        this.pageMap.set(p.id, pv);
        this.world.append(pv.el);
      }
      pv.layout(p, side + (maxW - p.w) / 2, y);
      y += p.h + GAP;
      next.push(pv);
      seen.add(p.id);
    }
    for (const [id, pv] of this.pageMap) if (!seen.has(id)) { pv.destroy(); this.pageMap.delete(id); }
    this.pages = next;
    this.docW = maxW + side * 2;
    this.docH = y;
    this.text.syncAll();
    this.clampCam();
    this.applyCam();
  }

  private side = 0;
  /** Room needed beside the pages for sticky notes parked in the margin. */
  private stickySide(): number {
    const st = this.doc.state;
    let side = 0;
    for (const o of st.objects.values()) {
      if (o.kind !== 'sticky') continue;
      const pw = st.page(o.page)?.w ?? 0;
      side = Math.max(side, -o.x, o.x + (o.open ? o.w : 30) - pw);
    }
    return side > 0 ? Math.ceil(side + 16) : 0;
  }

  drawOpts(page: Page): DrawOpts {
    return { hidden: this.hidden, dimAfter: this.playT, darkPaper: isDark(page.paper) };
  }

  pageView(id: string) { return this.pageMap.get(id); }

  pageAt(wx: number, wy: number, nearest: boolean): PageView | null {
    let best: PageView | null = null, bd = Infinity;
    for (const pv of this.pages) {
      if (inRect(pv.bounds, wx, wy)) return pv;
      if (nearest) {
        const b = pv.bounds;
        const dy = wy < b.y ? b.y - wy : wy > b.y + b.h ? wy - b.y - b.h : 0;
        const dx = wx < b.x ? b.x - wx : wx > b.x + b.w ? wx - b.x - b.w : 0;
        const d = dx + dy;
        if (d < bd) { bd = d; best = pv; }
      }
    }
    return best;
  }

  /** The page nearest the middle of the screen. */
  currentPage(): PageView {
    const c = this.screenToWorld(this.vw / 2, this.vh / 2);
    return this.pageAt(c.x, c.y, true) ?? this.pages[0];
  }

  objectAt(wx: number, wy: number, filter?: (o: PageObject) => boolean) {
    const pv = this.pageAt(wx, wy, false);
    if (!pv) return null;
    return hitObject(this.doc.state.objectsOn(pv.page.id), wx - pv.x, wy - pv.y, 8 / this.cam.z, filter);
  }

  screenToWorld(sx: number, sy: number): Pt {
    return { x: (sx - this.cam.tx) / this.cam.z, y: (sy - this.cam.ty) / this.cam.z };
  }

  /** Overlay drawing helpers: map page / world coordinates to overlay pixels. */
  pageTransform(ctx: CanvasRenderingContext2D, pv: PageView, clip = true) {
    const k = this.dpr * this.cam.z;
    ctx.setTransform(k, 0, 0, k, this.dpr * (this.cam.tx + pv.x * this.cam.z), this.dpr * (this.cam.ty + pv.y * this.cam.z));
    if (clip) { ctx.beginPath(); ctx.rect(0, 0, pv.page.w, pv.page.h); ctx.clip(); }
  }
  worldTransform(ctx: CanvasRenderingContext2D) {
    const k = this.dpr * this.cam.z;
    ctx.setTransform(k, 0, 0, k, this.dpr * this.cam.tx, this.dpr * this.cam.ty);
  }

  // ------------------------------------------------------------ camera

  private clampCam() {
    const c = this.cam;
    c.z = Math.min(MAX_Z, Math.max(MIN_Z, c.z));
    const W = this.docW * c.z, H = this.docH * c.z;
    c.tx = W <= this.vw ? (this.vw - W) / 2 : Math.min(24, Math.max(this.vw - W - 24, c.tx));
    c.ty = Math.min(TOP, Math.max(Math.min(TOP, this.vh - H - 24), c.ty));
  }

  private applyCam() {
    this.clampCam();
    const { z, tx, ty } = this.cam;
    this.world.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${z})`;
    if (Math.abs(z - this.renderZ) > 1e-4) {
      clearTimeout(this.zoomTimer);
      this.zoomTimer = window.setTimeout(() => { this.renderZ = this.cam.z; this.requestFrame(); this.saveView(); }, 110);
    }
    this.toolbar?.positionSelMenu();
    this.toolbar?.showPageBadge();
    this.requestFrame();
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const c = this.cam;
    const z = Math.min(MAX_Z, Math.max(MIN_Z, c.z * factor));
    c.tx = sx - ((sx - c.tx) * z) / c.z;
    c.ty = sy - ((sy - c.ty) * z) / c.z;
    c.z = z;
    this.applyCam();
  }

  fitWidth() {
    // Paper runs edge to edge (like Notability) unless the window is very wide.
    const side = this.vw > 1400 ? 64 : 0;
    const z = Math.min(2.4, Math.max(MIN_Z, (this.vw - 2 * side) / this.docW));
    // Full-bleed paper starts at the very top, under the floating toolbar.
    const anchor = side ? TOP : 0;
    const top = (anchor - this.cam.ty) / this.cam.z;
    this.cam.z = z;
    this.cam.ty = anchor - Math.max(0, top) * z;
    this.renderZ = z;
    this.applyCam();
  }

  scrollToPage(pv: PageView) {
    this.cam.ty = TOP - pv.y * this.cam.z;
    this.applyCam();
  }

  private restoreView() {
    try {
      const v = JSON.parse(localStorage.getItem(`inkwell.view.${this.meta.id}`) ?? 'null');
      if (v && typeof v.z === 'number') {
        Object.assign(this.cam, v);
        this.renderZ = this.cam.z;
        this.applyCam();
        return;
      }
    } catch { /* ignore */ }
    this.cam.ty = 0;
    this.fitWidth();
  }

  private saveView() {
    try { localStorage.setItem(`inkwell.view.${this.meta.id}`, JSON.stringify(this.cam)); } catch { /* ignore */ }
  }

  /** The viewport's size changed (e.g. the outline panel opened): refit the page. */
  relayout() {
    this.resize();
    this.fitWidth();
  }

  private resize() {
    const r = this.viewport.getBoundingClientRect();
    this.vw = r.width;
    this.vh = r.height;
    this.dpr = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
    this.overlay.width = Math.round(this.vw * this.dpr);
    this.overlay.height = Math.round(this.vh * this.dpr);
    this.overlay.style.width = `${this.vw}px`;
    this.overlay.style.height = `${this.vh}px`;
    this.applyCam();
  }

  // ------------------------------------------------------------ rendering

  requestFrame() {
    if (!this.frame && !this.closed) this.frame = requestAnimationFrame(() => this.render());
  }

  private render() {
    this.frame = 0;
    const { z, tx, ty } = this.cam;
    const vx = -tx / z, vy = -ty / z, vw = this.vw / z, vh = this.vh / z;
    const scale = this.renderZ * this.dpr;
    const near = { x: vx, y: vy - vh, w: vw, h: vh * 3 };
    for (const pv of this.pages) {
      const b = pv.bounds;
      const visible = intersects(b, { x: vx, y: vy, w: vw, h: vh });
      pv.update(visible ? { x: vx - b.x, y: vy - b.y, w: vw, h: vh } : null, scale, intersects(b, near));
      pv.flush();
    }
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.save();
    this.tool.overlay?.(ctx);
    ctx.restore();
    if (this.hover && this.drawId == null) this.drawCursor(ctx, this.hover);
  }

  /** Hover cursor for mouse/pencil hover: a dot showing the real tip size and ink color. */
  private hover: Pt | null = null;
  private drawCursor(ctx: CanvasRenderingContext2D, w: Pt) {
    const t = settings.tool;
    if (t !== 'pen' && t !== 'highlighter' && t !== 'shape' && t !== 'eraser') return;
    const { z, tx, ty } = this.cam;
    const d = this.dpr;
    const x = (tx + w.x * z) * d, y = (ty + w.y * z) * d;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    if (t === 'eraser') {
      ctx.arc(x, y, (settings.eraser.size / 2) * d, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fill();
      ctx.lineWidth = d;
      ctx.strokeStyle = 'rgba(28,25,23,0.55)';
      ctx.stroke();
      return;
    }
    const hl = t === 'highlighter';
    const r = Math.max(1.6 * d, ((hl ? settings.highlighter.width : settings.pen.width) / 2) * z * d);
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = hl ? settings.highlighter.color : settings.pen.color;
    ctx.globalAlpha = hl ? 0.6 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.2 * d;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r + 1.2 * d, 0, Math.PI * 2);
    ctx.lineWidth = 0.8 * d;
    ctx.strokeStyle = 'rgba(28,25,23,0.35)';
    ctx.stroke();
  }

  setHidden(ids: string[]) {
    const st = this.doc.state;
    for (const id of new Set([...this.hidden, ...ids])) {
      const o = st.objects.get(id);
      if (o && o.kind !== 'text') this.pageMap.get(o.page)?.invalidate(objBounds(o));
    }
    this.hidden = new Set(ids);
    this.requestFrame();
  }

  private onMedia(hash: string) {
    for (const pv of this.pages) {
      if (pv.page.bg === hash || this.doc.state.objectsOn(pv.page.id).some((o) => o.kind === 'image' && o.media === hash)) pv.invalidate('all');
    }
    this.requestFrame();
  }

  // ------------------------------------------------------------ document changes + persistence

  private onChange(ch: Change, logged: LoggedOp[]) {
    // A sticky moved into (or out of) the margin changes how much room the pages need.
    if (ch.layout || (ch.texts.size && this.stickySide() !== this.side)) this.layoutPages();
    for (const [page, r] of ch.dirty) this.pageMap.get(page)?.invalidate(r);
    for (const page of ch.full) this.pageMap.get(page)?.reset();
    this.text.sync(ch.texts);
    this.tools.lasso.refresh();
    this.byTime = null;
    this.toolbar.docChanged(ch.layout);
    if (logged.length) {
      db.appendOps(this.meta.id, logged).catch((e) => { console.error(e); toast('Could not save — storage may be full'); });
      this.opsSinceSnap += logged.length;
      if (this.opsSinceSnap >= SNAPSHOT_EVERY) this.snapshot();
      this.scheduleMeta();
    }
    this.toolbar.update();
    this.requestFrame();
  }

  /** Commit content, keeping one blank page at the end like a paper notebook. */
  commitContent(ops: Op[], pageId: string) {
    const st = this.doc.state;
    const last = st.pages[st.pages.length - 1];
    if (last?.id === pageId) ops = [...ops, { t: 'addPage', page: newPage(last), after: last.id }];
    this.doc.commit(ops);
  }

  /** Persist everything now (before export, on hide). */
  async flush() {
    this.text.finish();
    await this.snapshot();
    await this.saveMeta(true);
  }

  private snapshot() {
    this.opsSinceSnap = 0;
    return db.putSnapshot(this.meta.id, this.doc.state.toSnapshot(), this.doc.lamport).catch(console.error);
  }

  private scheduleMeta() {
    clearTimeout(this.metaTimer);
    this.metaTimer = window.setTimeout(() => this.saveMeta(), 1200);
    clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => this.saveMeta(true), 6000);
  }

  async saveMeta(thumb = false) {
    const m = this.meta;
    m.modified = Date.now();
    m.pageCount = this.doc.state.pages.length;
    const texts: string[] = [];
    for (const o of this.doc.state.objects.values()) if (o.kind === 'text' || o.kind === 'sticky') texts.push(o.text);
    m.searchText = texts.join(' ').slice(0, 8000);
    if (thumb) {
      const p = this.doc.state.pages[0];
      if (p) {
        try {
          const c = renderPageToCanvas(p, this.doc.state.objectsOn(p.id), 300 / p.w);
          m.thumb = c.toDataURL('image/jpeg', 0.8);
          c.width = c.height = 0;
        } catch (e) { console.warn('thumbnail failed', e); }
      }
    }
    await db.putNote(m).catch(console.error);
  }

  // ------------------------------------------------------------ tools

  /** Last tool before the current one (for "auto-deselect eraser"). */
  prevTool: ToolName = 'pen';

  setTool(name: ToolName) {
    if (settings.tool !== name && settings.tool !== 'eraser') this.prevTool = settings.tool;
    if (this.tool !== this.tools[name]) {
      this.tool.cancel();
      this.tool.deactivate?.();
    }
    this.text.finish();
    settings.tool = name;
    saveSettings();
    this.tool = this.tools[name];
    this.root.classList.toggle('tool-text', name === 'text');
    this.root.classList.toggle('dot-cursor', name === 'pen' || name === 'highlighter' || name === 'shape' || name === 'eraser');
    this.toolbar.update();
    this.requestFrame();
  }

  showSelectionMenu() { this.toolbar.showSelMenu(); }
  hideSelectionMenu() { this.toolbar.hideSelMenu(); }

  async insertImage(file: Blob) {
    try {
      const hash = await db.putMedia(file);
      const img = await decode(file);
      media.put(hash, img);
      const pv = this.currentPage();
      const vis = this.screenToWorld(this.vw / 2, this.vh / 2);
      const w = Math.min(img.width, pv.page.w * 0.7), h = (w * img.height) / img.width;
      const cx = Math.min(pv.page.w - w / 2, Math.max(w / 2, vis.x - pv.x));
      const cy = Math.min(pv.page.h - h / 2, Math.max(h / 2, vis.y - pv.y));
      const id = uid();
      this.commitContent([{ t: 'add', obj: { kind: 'image', id, page: pv.page.id, createdAt: this.timeline(), x: cx - w / 2, y: cy - h / 2, w, h, media: hash } }], pv.page.id);
      this.setTool('lasso');
      this.tools.lasso.setSel([id]);
    } catch (e) {
      console.error(e);
      toast('Could not insert that image');
    }
  }

  // ------------------------------------------------------------ audio

  timeline(): number {
    const c = this.recorder.clip;
    return c ? c.start + this.recorder.elapsed() : timelineEnd(this.meta.clips);
  }

  async toggleRecord() {
    if (this.recorder.active) {
      const r = await this.recorder.stop();
      if (r) {
        await db.putAudio({ id: r.clip.id, note: this.meta.id, blob: r.blob });
        await db.deleteChunks(r.clip.id);
        this.meta.clips.push(r.clip);
        if (this.player) this.player.clips = this.meta.clips;
        await this.saveMeta();
      }
      this.toolbar.update();
      return;
    }
    if (!Recorder.supported()) { toast('Recording is not supported in this browser'); return; }
    this.exitReplay();
    try {
      await this.recorder.start(this.meta.id, timelineEnd(this.meta.clips));
      this.toolbar.update();
    } catch (e) {
      console.error(e);
      toast(location.protocol === 'https:' || location.hostname === 'localhost' ? 'Microphone access was denied' : 'Recording needs HTTPS');
    }
  }

  ensurePlayer(): Player {
    if (!this.player) {
      this.player = new Player(this.meta.clips);
      this.player.onTime = (t) => this.setPlayT(t);
      this.player.onState = () => this.toolbar.update();
    }
    return this.player;
  }

  /** Replay: ink created after T is faded, and taps seek audio to when ink was written. */
  setPlayT(t: number) {
    const prev = this.playT;
    this.playT = t;
    if (prev == null) for (const pv of this.pages) pv.invalidate('all');
    else if (prev !== t) {
      if (!this.byTime) this.byTime = [...this.doc.state.objects.values()].sort((a, b) => a.createdAt - b.createdAt);
      const lo = Math.min(prev, t), hi = Math.max(prev, t);
      let n = 0;
      for (const o of this.byTime) {
        if (o.createdAt <= lo) continue;
        if (o.createdAt > hi) break;
        if (++n > 400) { for (const pv of this.pages) pv.invalidate('all'); break; }
        if (o.kind !== 'text') this.pageMap.get(o.page)?.invalidate(objBounds(o));
      }
    }
    this.text.setDim(t);
    if (prev == null) this.toolbar.update();
    else this.toolbar.updateTime();
    this.requestFrame();
  }

  exitReplay() {
    if (this.playT == null) return;
    this.player?.pause();
    this.playT = null;
    for (const pv of this.pages) pv.invalidate('all');
    this.text.setDim(null);
    this.toolbar.update();
    this.requestFrame();
  }

  private seekToObjectAt(w: Pt) {
    const hit = this.objectAt(w.x, w.y);
    if (!hit) return;
    const p = this.ensurePlayer();
    p.seek(Math.max(0, hit.createdAt - 1.5)).then(() => { if (!p.playing) p.play(); });
  }

  // ------------------------------------------------------------ input

  private bindInput() {
    const v = this.viewport;
    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn, opts);
      this.unsubs.push(() => t.removeEventListener(type, fn, opts));
    };
    on(v, 'pointerdown', (e: PointerEvent) => this.onDown(e));
    on(v, 'pointermove', (e: PointerEvent) => this.onMove(e));
    on(v, 'pointerup', (e: PointerEvent) => this.onUp(e, false));
    on(v, 'pointercancel', (e: PointerEvent) => this.onUp(e, true));
    on(v, 'lostpointercapture', (e: PointerEvent) => { if (e.pointerId === this.drawId) this.onUp(e, false); });
    on(v, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    on(v, 'contextmenu', (e: Event) => e.preventDefault());
    on(v, 'pointerleave', () => { this.hover = null; this.requestFrame(); });
    // Safari trackpad pinch (macOS) arrives as gesture events.
    let gs = 1;
    on(v, 'gesturestart', (e: any) => { e.preventDefault(); gs = 1; });
    on(v, 'gesturechange', (e: any) => {
      e.preventDefault();
      const r = v.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, e.scale / gs);
      gs = e.scale;
    });
    on(window, 'resize', () => this.resize());
    on(document, 'keydown', (e: KeyboardEvent) => this.onKey(e, true));
    on(document, 'keyup', (e: KeyboardEvent) => this.onKey(e, false));
    on(document, 'paste', (e: ClipboardEvent) => this.onPaste(e));
    on(v, 'dragover', (e: DragEvent) => e.preventDefault());
    on(v, 'drop', (e: DragEvent) => {
      e.preventDefault();
      for (const f of e.dataTransfer?.files ?? []) {
        if (f.type.startsWith('image/')) this.insertImage(f);
        else if (f.type === 'application/pdf') this.toolbar.insertPdf(f);
      }
    });
    const flush = () => { if (document.visibilityState === 'hidden') { this.text.finish(); this.snapshot(); this.saveMeta(true); } };
    on(document, 'visibilitychange', flush);
    on(window, 'pagehide', flush);
  }

  private local(e: PointerEvent | MouseEvent): Pt {
    const r = this.viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private sample(e: PointerEvent): Sample {
    const p = this.local(e);
    const w = this.screenToWorld(p.x, p.y);
    return { x: w.x, y: w.y, p: e.pointerType === 'mouse' ? 0.5 : e.pressure, t: e.timeStamp };
  }

  private onDown(e: PointerEvent) {
    if (this.text.isEditingTarget(e.target)) return;
    if ((e.target as HTMLElement).closest?.('.sticky')) return; // stickies handle their own taps and drags
    if ((e.target as HTMLElement).closest?.('.sel-menu')) return;
    this.text.finish();
    cancelAnimationFrame(this.inertia);
    try { this.viewport.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    const p = this.local(e);
    const type = e.pointerType;

    if (type === 'pen') {
      if (settings.fingerDraw) {
        settings.fingerDraw = false;
        saveSettings();
        toast('Apple Pencil detected — fingers now scroll. Change it in the ⋯ menu.', 4000);
      }
      // Palm rejection: a pen landing cancels any palm-driven gesture.
      if (this.gesture) { for (const id of this.ptrs.keys()) this.ignored.add(id); this.ptrs.clear(); this.gesture = null; }
      if (this.drawId != null && this.drawType === 'touch') { this.tool.cancel(); this.drawId = null; }
    }

    if (type === 'touch') {
      if (this.drawId != null && this.drawType === 'pen') { this.ignored.add(e.pointerId); return; }
      this.ptrs.set(e.pointerId, p);
      if (this.ptrs.size === 2) {
        if (this.drawId != null) { this.tool.cancel(); this.drawId = null; }
        this.tap = null;
        this.startPinch();
        return;
      }
      if (this.ptrs.size > 2) return;
      if (this.playT != null || !settings.fingerDraw) {
        this.startPan(e.pointerId, p);
        this.tap = { id: e.pointerId, x: p.x, y: p.y, t: e.timeStamp };
        return;
      }
      this.startDraw(e);
      return;
    }

    if (type === 'mouse' && (e.button === 1 || e.button === 2 || this.spaceDown)) { this.startPan(e.pointerId, p); return; }
    if (type === 'mouse' && e.button !== 0) return;
    if (this.drawId != null) return;
    if (this.playT != null) { this.tap = { id: e.pointerId, x: p.x, y: p.y, t: e.timeStamp }; return; }
    this.startDraw(e);
  }

  private startDraw(e: PointerEvent) {
    this.drawId = e.pointerId;
    this.drawType = e.pointerType;
    this.tool.down(this.sample(e));
  }

  private onMove(e: PointerEvent) {
    if (e.pointerId === this.drawId) {
      const co = e.getCoalescedEvents?.();
      const samples = (co && co.length ? co : [e]).map((x) => this.sample(x));
      // Mouse prediction is linear extrapolation that zig-zags at the tip; only trust pens.
      const pr = e.pointerType === 'pen' ? e.getPredictedEvents?.() ?? [] : [];
      this.tool.move(samples, pr.map((x) => this.sample(x)));
      return;
    }
    if (this.ignored.has(e.pointerId)) return;
    const p = this.local(e);
    if (e.pointerType !== 'touch' && !e.buttons) { this.hover = this.screenToWorld(p.x, p.y); this.requestFrame(); }
    if (this.tap?.id === e.pointerId && Math.hypot(p.x - this.tap.x, p.y - this.tap.y) > 8) this.tap = null;
    if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, p);
    const g = this.gesture;
    if (g?.kind === 'pinch' && this.ptrs.size >= 2) this.updatePinch();
    else if (g?.kind === 'pan' && g.id === e.pointerId) this.updatePan(p, e.timeStamp);
  }

  private onUp(e: PointerEvent, cancelled: boolean) {
    if (e.pointerId === this.drawId) {
      this.drawId = null;
      this.ptrs.delete(e.pointerId);
      if (cancelled) this.tool.cancel();
      else this.tool.up(this.sample(e));
      return;
    }
    if (this.ignored.delete(e.pointerId)) return;
    this.ptrs.delete(e.pointerId);
    const g = this.gesture;
    if (this.selGesture && this.ptrs.size < 2) {
      // Lifting a finger ends the selection gesture (no panning afterwards).
      this.selGesture = null;
      this.tools.lasso.gestureEnd();
      this.gesture = null;
      return;
    }
    if (g?.kind === 'pinch') {
      if (this.ptrs.size === 1) {
        const [id, p] = [...this.ptrs][0];
        this.startPan(id, p);
      } else if (!this.ptrs.size) this.gesture = null;
    } else if (g?.kind === 'pan' && g.id === e.pointerId) {
      this.gesture = null;
      if (!cancelled) this.fling(g);
    }
    const t = this.tap;
    this.tap = null;
    if (t && t.id === e.pointerId && !cancelled && e.timeStamp - t.t < 500) {
      const w = this.screenToWorld(t.x, t.y);
      if (this.playT != null) this.seekToObjectAt(w);
      else if (this.tool === this.tools.text) this.tools.text.tap(w);
      else if (this.tool === this.tools.lasso) {
        const s = { x: w.x, y: w.y, p: 0.5, t: e.timeStamp };
        this.tools.lasso.down(s);
        this.tools.lasso.up(s);
      }
    }
  }

  private startPan(id: number, p: Pt) {
    this.gesture = { kind: 'pan', id, x: p.x, y: p.y, vx: 0, vy: 0, t: performance.now() };
  }

  private updatePan(p: Pt, _ts: number) {
    const g = this.gesture as Extract<Gesture, { kind: 'pan' }>;
    const now = performance.now();
    const dt = Math.max(1, now - g.t);
    const dx = p.x - g.x, dy = p.y - g.y;
    g.vx = g.vx * 0.5 + (dx / dt) * 0.5;
    g.vy = g.vy * 0.5 + (dy / dt) * 0.5;
    g.x = p.x; g.y = p.y; g.t = now;
    this.cam.tx += dx;
    this.cam.ty += dy;
    this.applyCam();
  }

  private fling(g: Extract<Gesture, { kind: 'pan' }>) {
    if (performance.now() - g.t > 80) return;
    let vx = g.vx, vy = g.vy, last = performance.now();
    if (Math.hypot(vx, vy) < 0.15) return;
    const step = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      this.cam.tx += vx * dt;
      this.cam.ty += vy * dt;
      const decay = Math.pow(0.994, dt);
      vx *= decay; vy *= decay;
      this.applyCam();
      if (Math.hypot(vx, vy) > 0.02) this.inertia = requestAnimationFrame(step);
    };
    this.inertia = requestAnimationFrame(step);
  }

  /** Two fingers on a selection: pinch/twist/slide it (Select tool). */
  private selGesture: { d0: number; a0: number; c0: Pt } | null = null;

  private startPinch() {
    const [a, b] = [...this.ptrs.values()];
    if (this.tool === this.tools.lasso) {
      const mid = this.screenToWorld((a.x + b.x) / 2, (a.y + b.y) / 2);
      if (this.tools.lasso.gestureStart(mid)) {
        this.selGesture = { d0: Math.max(10, Math.hypot(b.x - a.x, b.y - a.y)), a0: Math.atan2(b.y - a.y, b.x - a.x), c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        this.gesture = { kind: 'pinch', d0: 1, cx: 0, cy: 0, z0: this.cam.z, tx0: this.cam.tx, ty0: this.cam.ty };
        return;
      }
    }
    this.gesture = {
      kind: 'pinch', d0: Math.max(10, Math.hypot(b.x - a.x, b.y - a.y)),
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, z0: this.cam.z, tx0: this.cam.tx, ty0: this.cam.ty,
    };
  }

  private updatePinch() {
    const g = this.gesture as Extract<Gesture, { kind: 'pinch' }>;
    const [a, b] = [...this.ptrs.values()];
    if (this.selGesture) {
      const sg = this.selGesture, z = this.cam.z;
      const d = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      this.tools.lasso.gestureUpdate(d / sg.d0, ang - sg.a0, (cx - sg.c0.x) / z, (cy - sg.c0.y) / z);
      return;
    }
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const z = Math.min(MAX_Z, Math.max(MIN_Z, (g.z0 * d) / g.d0));
    // Keep the world point that was under the pinch center under the fingers.
    const wx = (g.cx - g.tx0) / g.z0, wy = (g.cy - g.ty0) / g.z0;
    this.cam.z = z;
    this.cam.tx = cx - wx * z;
    this.cam.ty = cy - wy * z;
    this.applyCam();
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.vh : 1;
    const p = this.local(e);
    if (e.ctrlKey || e.metaKey) this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * k * 0.01));
    else {
      this.cam.tx -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k;
      this.cam.ty -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k;
      this.applyCam();
    }
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const t = e.target as HTMLElement;
    if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (document.querySelector('.modal-back')) return;
    if (e.code === 'Space') { this.spaceDown = down; e.preventDefault(); return; }
    if (!down) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const lasso = this.tools.lasso;
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this.doc.redo() : this.doc.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); this.doc.redo(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); this.zoomAt(this.vw / 2, this.vh / 2, 1.25); return; }
    if (mod && k === '-') { e.preventDefault(); this.zoomAt(this.vw / 2, this.vh / 2, 0.8); return; }
    if (mod && k === '0') { e.preventDefault(); this.fitWidth(); return; }
    if (mod && k === 'c' && lasso.sel) { e.preventDefault(); lasso.copy(); return; }
    if (mod && k === 'x' && lasso.sel) { e.preventDefault(); lasso.copy(); lasso.remove(); return; }
    if (mod && k === 'd' && lasso.sel) { e.preventDefault(); lasso.duplicate(); return; }
    if (mod) return;
    if ((k === 'backspace' || k === 'delete') && lasso.sel) { e.preventDefault(); lasso.remove(); return; }
    if (k === 'escape') { lasso.clear(); this.exitReplay(); return; }
    const map: Record<string, ToolName> = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', s: 'shape', t: 'text' };
    if (map[k]) this.setTool(map[k]);
  }

  private onPaste(e: ClipboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const img = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (img) { e.preventDefault(); this.insertImage(img); return; }
    const text = e.clipboardData?.getData('text/plain') ?? '';
    // Inkwell's own copy leaves a marker on the system clipboard; anything else is outside text.
    if (text && text !== OBJECTS_MARKER) { e.preventDefault(); this.pasteText(text); return; }
    this.pasteHere();
  }

  /** Drop a new open sticky note near the middle of the screen. */
  addSticky() {
    const pv = this.currentPage();
    const c = this.screenToWorld(this.vw / 2, this.vh / 3);
    const w = 220, h = 170;
    const obj: StickyObj = {
      kind: 'sticky', id: uid(), page: pv.page.id, createdAt: this.timeline(),
      x: Math.max(12, Math.min(pv.page.w - w - 12, c.x - pv.x - w / 2)), y: Math.max(12, Math.min(pv.page.h - h - 12, c.y - pv.y)),
      w, h, text: '', color: '#fff3a3', open: true,
    };
    this.commitContent([{ t: 'add', obj }], pv.page.id);
    this.text.focusSticky(obj.id);
  }

  /**
   * Paste and match formatting: outside text drops its fonts, colors and
   * sizes and becomes a text box in the current text style.
   */
  pasteText(raw: string) {
    const text = raw.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return;
    const pv = this.currentPage();
    const c = this.screenToWorld(this.vw / 2, this.vh / 3);
    const t = settings.text;
    const w = Math.min(420, pv.page.w - 72);
    const x = Math.max(36, Math.min(pv.page.w - w - 36, c.x - pv.x - w / 2));
    const y = Math.max(36, Math.min(pv.page.h - 60, c.y - pv.y));
    const perLine = Math.max(10, Math.floor(w / (t.size * 0.52)));
    const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
    const obj: TextObj = { kind: 'text', id: uid(), page: pv.page.id, createdAt: this.timeline(), x, y, w, h: lines * t.size * 1.3, text, size: t.size, color: t.color, bold: t.bold, font: t.font };
    this.commitContent([{ t: 'add', obj }], pv.page.id);
    toast('Pasted in your text style');
  }

  pasteHere() {
    const c = this.screenToWorld(this.vw / 2, this.vh / 2);
    this.setTool('lasso');
    this.tools.lasso.paste(c);
  }

  /** Screen rect of a world rect (for positioning DOM chrome). */
  worldToScreenRect(r: Rect): Rect {
    const { z, tx, ty } = this.cam;
    const vr = this.viewport.getBoundingClientRect();
    return { x: vr.left + tx + r.x * z, y: vr.top + ty + r.y * z, w: r.w * z, h: r.h * z };
  }

  // ------------------------------------------------------------ lifecycle

  private closing: Promise<void> | null = null;
  close() { return (this.closing ??= this.doClose()); }

  private async doClose() {
    this.text.finish();
    if (this.recorder.active) await this.toggleRecord();
    this.closed = true;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.inertia);
    clearTimeout(this.metaTimer);
    clearTimeout(this.thumbTimer);
    clearTimeout(this.zoomTimer);
    this.player?.destroy();
    this.saveView();
    await this.snapshot();
    await this.saveMeta(true);
    for (const u of this.unsubs) u();
    for (const pv of this.pages) pv.destroy();
    this.root.remove();
  }
}
