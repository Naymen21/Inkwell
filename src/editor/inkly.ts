// Inkly: the AI study assistant sidebar. It asks Claude through the claude.ai
// artifact runtime (`claude.use("sample")`), which runs on the viewer's own
// Claude plan — no API key, nothing billed elsewhere. Outside claude.ai the
// runtime is absent and the panel explains how to open Inkwell there.
import type { Op, Page, TextObj } from '../model/types';
import { renderPageToCanvas } from '../render/draw';
import { media } from '../render/media';
import { icons } from '../ui/icons';
import { esc } from '../ui/modal';
import { uid } from '../util/ids';
import { useCapability } from '../util/claude';
import { serverBackend, setPasscode } from './inklyServer';
import { Credits, formatWait } from './credits';
import { settings } from './settings';
import type { Editor } from './editor';
import { newPage } from './editor';

type Role = 'user' | 'assistant';
interface Turn { role: Role; content: string; label?: string; failed?: boolean }

type SampleErr = { code?: string; message?: string; text?: string; retryAfter?: number; daily?: boolean };
interface SampleFn {
  (input: string | { role: Role; content: string }[], opts?: Record<string, unknown>): Promise<{ text: string; truncated: boolean }>;
  limits(): Promise<{ maxPromptBytes: number; images?: { maxCount: number } }>;
  provider?: string;
}

/** Where people open the claude.ai-hosted copy (set after publishing). */
export const CLAUDE_COPY_URL = 'https://claude.ai/artifact/A6PyChCAAxJhTwABrX5ND6';

// Inside Claude, Inkly runs on the viewer's Claude plan; anywhere else it uses
// this deployment's own /api/inkly function (Gemini), if one is configured.
let samplePromise: Promise<SampleFn | null> | null = null;
const getSample = () => (samplePromise ??= useCapability<SampleFn>('sample').then(async (s) => {
  if (s) {
    // The platform's function is frozen; wrap it rather than tagging it.
    const w = ((input, opts) => s(input, opts)) as SampleFn;
    w.limits = () => s.limits();
    w.provider = 'Claude';
    return w;
  }
  const server = (await serverBackend()) as SampleFn | null;
  // Not available yet (e.g. the key was added after this page loaded): check again next time.
  if (!server) samplePromise = null;
  return server;
}));

const RULES = `You are Inkly, the friendly study assistant inside Inkwell, a handwriting notes app for students.
You are given the student's note: page images (their handwriting, highlights, drawings and any imported PDF pages) and the typed text from it.
- Ground everything in the note. Read the handwriting carefully. If something is not in the note, say so briefly, then help from general knowledge and label it as such.
- Be clear, accurate and concise; write for a high-school or college student.
- Format: short section headings on their own line starting with "## ", bullets starting with "- ", numbered steps "1. ", and **bold** for key terms. No tables, no code blocks, no LaTeX (write math in plain text, e.g. x^2 + 3x).`;

const ACTIONS: { id: string; label: string; scope: 'page' | 'note'; prompt: string; add?: string }[] = [
  {
    id: 'guide', label: 'Study guide', scope: 'note', add: 'Add study guide to note',
    prompt: 'Turn this whole note into a study guide. Sections: "## Big picture" (2-3 sentences), "## Key terms" (term — definition), "## Main ideas" (bullets, grouped by topic), "## Things to remember" (formulas, dates, steps), and "## Check yourself" (5 short questions, answers in parentheses).',
  },
  { id: 'sum', label: 'Summarize page', scope: 'page', prompt: 'Summarize this page in 4-6 bullets, then one line on why it matters.', add: 'Add summary to note' },
  {
    id: 'cards', label: 'Flashcards', scope: 'note', add: 'Add flashcards to note',
    prompt: 'Make 10 flashcards from this note. Format each as "- **Front** — back". Mix definitions, cause/effect and application.',
  },
  { id: 'quiz', label: 'Quiz me', scope: 'note', prompt: 'Quiz me on this note. Ask ONE question at a time and wait for my answer; after I answer, tell me if I was right, explain briefly, then ask the next question. Start with question 1 now.' },
];

const ERRORS: Record<string, string> = {
  not_granted: 'Inkly needs your OK to use Claude. Reload and choose Allow when asked.',
  passcode: 'This Inkly needs a passcode. Enter it below.',
  busy: 'The free AI is busy right now. Try again in a minute.',
  not_configured: 'Inkly’s AI key is missing or invalid on the server.',
  sampling_disabled: 'Claude isn’t available on this account.',
  rate_limited: 'You’ve hit your Claude usage limit for now. Try again a bit later.',
  session_expired: 'Your Claude session expired — sign in again, then retry.',
  refused: 'Claude declined that one. Try rephrasing.',
  prompt_too_large: 'This note is too big to send at once. Try “This page” instead.',
  image_rejected: 'A page image couldn’t be sent. Try “This page”.',
  empty_completion: 'No answer came back. Try asking a little differently.',
  upstream_error: 'Connection hiccup. Try again.',
};

const objIds = new WeakMap<object, number>();
let nextObjId = 1;
/** A key that changes whenever an object is replaced by an edit. */
function objectKey(o: object) {
  let k = objIds.get(o);
  if (!k) { k = nextObjId++; objIds.set(o, k); }
  return k;
}

/** Tiny safe markdown: escape first, then headings, bullets, numbers, bold. */
function renderMd(src: string): string {
  const lines = esc(src).split('\n');
  let html = '';
  let list: 'ul' | 'ol' | null = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  const inline = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  for (const raw of lines) {
    const l = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^#{1,4}\s+(.*)/))) { close(); html += `<h4>${inline(m[1])}</h4>`; }
    else if ((m = l.match(/^\s*[-•*]\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
    else if (!l.trim()) close();
    else { close(); html += `<p>${inline(l)}</p>`; }
  }
  close();
  return html;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export class InklyPanel {
  readonly el = h('aside', 'inkly glass');
  private log = h('div', 'inkly-log');
  private input = h('textarea', 'inkly-input');
  private sendBtn = h('button', 'inkly-send');
  private scopeSeg = h('div', 'segmented inkly-scope');
  // Reading just this page is much faster; study guide / flashcards still read the whole note.
  private scope: 'page' | 'note' = 'page';
  private turns: Turn[] = [];
  private busy: AbortController | null = null;
  private sample: SampleFn | null = null;
  private ready = false;

  constructor(private ed: Editor) {
    this.load();
    this.build();
    getSample().then((s) => { this.sample = s; this.ready = true; this.renderLog(); });
  }

  get isOpen() { return this.el.classList.contains('open'); }

  toggle(open = !this.isOpen) {
    this.el.classList.toggle('open', open);
    if (open && this.ready && !this.sample) getSample().then((s) => { if (s) { this.sample = s; this.renderLog(); } });
    if (open) setTimeout(() => { if (matchMedia('(pointer: fine)').matches) this.input.focus(); }, 250);
  }

  private key() { return `inkwell.inkly.${this.ed.meta.id}`; }
  private load() {
    try { this.turns = JSON.parse(localStorage.getItem(this.key()) ?? '[]'); } catch { this.turns = []; }
  }
  private save() {
    try { localStorage.setItem(this.key(), JSON.stringify(this.turns.filter((t) => !t.failed).slice(-40))); } catch { /* full */ }
  }

  private build() {
    const head = h('div', 'inkly-head');
    head.innerHTML = `<span class="inkly-avatar">${icons.inkly}</span><div class="inkly-title"><b>Inkly</b><span class="ai-pill">AI</span><span class="inkly-credits" aria-live="polite"></span></div>`;
    const clear = h('button', 'icon-btn small', icons.restore);
    clear.title = 'New chat';
    clear.setAttribute('aria-label', 'New chat');
    clear.onclick = () => { this.busy?.abort(); this.turns = []; this.save(); this.renderLog(); };
    const close = h('button', 'icon-btn small', icons.close);
    close.setAttribute('aria-label', 'Close Inkly');
    close.onclick = () => this.toggle(false);
    head.append(clear, close);

    for (const [v, l] of [['page', 'This page'], ['note', 'Whole note']] as const) {
      const b = h('button', this.scope === v ? 'on' : '', l);
      b.onclick = () => { this.scope = v; this.scopeSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
      this.scopeSeg.append(b);
    }
    const scopeRow = h('div', 'inkly-scope-row', '<span>Inkly reads</span>');
    scopeRow.append(this.scopeSeg);

    const compose = h('form', 'inkly-compose');
    this.input.rows = 1;
    this.input.placeholder = 'Ask about your notes…';
    this.input.setAttribute('aria-label', 'Message Inkly');
    this.input.oninput = () => { this.input.style.height = 'auto'; this.input.style.height = `${Math.min(140, this.input.scrollHeight)}px`; };
    this.input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); compose.requestSubmit(); }
    };
    this.sendBtn.type = 'submit';
    this.sendBtn.innerHTML = icons.send;
    this.sendBtn.setAttribute('aria-label', 'Send');
    compose.onsubmit = (e) => {
      e.preventDefault();
      if (this.busy) { this.busy.abort(); return; }
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = '';
      this.input.style.height = '';
      this.ask(text, text, this.scope);
    };
    compose.append(this.input, this.sendBtn);
    this.el.append(head, scopeRow, this.log, compose);
    this.renderLog();
  }

  private credits = new Credits(() => settings.inklyDailyCredits);
  private tick = 0;
  /** Credits only apply to the hosted Gemini backend; Claude uses the viewer's plan. */
  private get metered() { return !!this.sample && this.sample.provider !== 'Claude'; }

  private renderCredits() {
    const el = this.el.querySelector<HTMLElement>('.inkly-credits');
    if (!el) return;
    clearInterval(this.tick);
    if (!this.metered) { el.textContent = ''; el.className = 'inkly-credits'; this.setLocked(false); return; }
    const update = () => {
      const until = this.credits.blockedUntil();
      if (until) {
        el.textContent = `Out of credits · resets in ${formatWait(until - Date.now())}`;
        el.className = 'inkly-credits out';
        this.setLocked(true);
        if (until <= Date.now()) { this.renderCredits(); }
      } else {
        const left = this.credits.left, total = settings.inklyDailyCredits;
        el.textContent = `${left} of ${total} credits left`;
        el.className = `inkly-credits${left <= Math.max(3, total * 0.1) ? ' low' : ''}`;
        this.setLocked(false);
      }
    };
    update();
    this.tick = window.setInterval(update, 1000);
  }

  private setLocked(locked: boolean) {
    this.el.classList.toggle('no-credits', locked);
    this.input.disabled = locked;
    this.input.placeholder = locked ? 'Out of credits for today' : 'Ask about your notes…';
  }

  private renderLog() {
    const log = this.log;
    log.innerHTML = '';
    if (this.ready && !this.sample) {
      const card = h('div', 'inkly-empty');
      card.innerHTML = `<div class="inkly-hero">${icons.inkly}</div><h3>Inkly isn’t set up here yet</h3>
        <p>On the hosted app, Inkly uses a free Gemini key stored on the server. Or open Inkwell inside Claude to use your Claude plan.</p>
        ${CLAUDE_COPY_URL ? `<a class="inkly-cta" href="${CLAUDE_COPY_URL}" target="_blank" rel="noopener">${icons.spark}<span>Open Inkwell in Claude</span></a>` : ''}
        <p class="muted">Your notes here stay on this device; use “Export note file” to bring one along.</p>`;
      log.append(card);
      this.el.classList.add('offline');
      return;
    }
    this.el.classList.remove('offline');
    this.renderCredits();
    if (!this.turns.length) {
      const hi = h('div', 'inkly-msg bot');
      hi.innerHTML = `<span class="inkly-avatar sm">${icons.inkly}</span><div class="bubble"><p>Hi! I can read your handwriting and PDFs in this note. Want a study guide, a summary, or flashcards?</p></div>`;
      log.append(hi);
    }
    this.turns.forEach((t, i) => log.append(this.renderTurn(t, i)));
    const chips = h('div', 'inkly-chips');
    for (const a of ACTIONS) {
      const c = h('button', a.id === 'guide' ? 'inkly-chip primary' : 'inkly-chip', `${a.id === 'guide' ? icons.spark : ''}<span>${a.label}</span>`);
      c.disabled = !!this.busy;
      c.onclick = () => this.ask(a.prompt, a.label, a.scope, a.add);
      chips.append(c);
    }
    log.append(chips);
    log.scrollTop = log.scrollHeight;
    this.sendBtn.innerHTML = this.busy ? icons.stop : icons.send;
    this.sendBtn.setAttribute('aria-label', this.busy ? 'Stop' : 'Send');
    this.sendBtn.classList.toggle('stop', !!this.busy);
  }

  private renderTurn(t: Turn, i: number) {
    if (t.role === 'user') {
      const m = h('div', 'inkly-msg me');
      m.append(h('div', 'bubble', `<p>${esc(t.label ?? t.content)}</p>`));
      return m;
    }
    const m = h('div', `inkly-msg bot${t.failed ? ' failed' : ''}`);
    const b = h('div', 'bubble');
    b.innerHTML = t.content ? renderMd(t.content) : '<p class="thinking"><span></span><span></span><span></span></p>';
    m.append(h('span', 'inkly-avatar sm', icons.inkly), b);
    if (t.content && !t.failed && !(this.busy && i === this.turns.length - 1)) {
      const acts = h('div', 'inkly-acts');
      const prev = this.turns[i - 1];
      const addLabel = ACTIONS.find((a) => a.label === prev?.label)?.add ?? 'Add to note';
      const add = h('button', 'inkly-act strong', `${icons.plus}<span>${esc(addLabel)}</span>`);
      add.onclick = () => this.addToNote(t.content, prev?.label ?? 'Inkly');
      const copy = h('button', 'inkly-act', `${icons.copy}<span>Copy</span>`);
      copy.onclick = () => { navigator.clipboard?.writeText(t.content).then(() => { copy.querySelector('span')!.textContent = 'Copied'; }); };
      acts.append(add, copy);
      b.append(acts);
    }
    return m;
  }

  private askPasscode() {
    setTimeout(() => {
      const f = h('form', 'inkly-pass');
      const inp = h('input', 'field');
      inp.type = 'password';
      inp.placeholder = 'Inkly passcode';
      inp.setAttribute('aria-label', 'Inkly passcode');
      inp.onkeydown = (e) => e.stopPropagation();
      const ok = h('button', 'inkly-act strong', '<span>Save</span>');
      f.append(inp, ok);
      f.onsubmit = (e) => { e.preventDefault(); setPasscode(inp.value.trim()); f.remove(); };
      this.log.append(f);
      inp.focus();
    });
  }

  /** Pages to show Claude: the current one, or every page that has something on it. */
  private scopePages(scope: 'page' | 'note'): Page[] {
    const st = this.ed.doc.state;
    if (scope === 'page') return [this.ed.currentPage().page];
    return st.pages.filter((p) => p.bg || st.objectsOn(p.id).length);
  }

  private pageImages = new Map<string, { sig: string; blob: Blob }>();

  private async gather(scope: 'page' | 'note', maxImages: number) {
    const st = this.ed.doc.state;
    const pages = this.scopePages(scope);
    const all = st.pages;
    const parts: string[] = [`Note title: ${this.ed.meta.title}`];
    for (const p of pages) {
      const typed = st.objectsOn(p.id).filter((o): o is TextObj => o.kind === 'text').map((o) => o.text).join('\n');
      if (typed.trim()) parts.push(`Typed text on page ${all.indexOf(p) + 1}:\n${typed}`);
    }
    // Only pages with handwriting, images or a PDF need a picture; typed text is sent as text.
    const visual = pages.filter((p) => p.bg || st.objectsOn(p.id).some((o) => o.kind !== 'text'));
    const imgPages = visual.slice(0, maxImages);
    if (visual.length > imgPages.length) parts.push(`(Only the first ${imgPages.length} of ${visual.length} handwritten pages are attached as images.)`);
    if (!pages.length) parts.push('(The note is empty so far.)');
    const images: Blob[] = [];
    for (const p of imgPages) {
      const objs = st.objectsOn(p.id);
      // Objects are replaced (never mutated) on change, so their identities describe the page.
      const sig = `${p.bg ?? ''}|${p.template}|${p.paper}|${objs.map((o) => objectKey(o)).join(',')}`;
      const hit = this.pageImages.get(p.id);
      if (hit && hit.sig === sig) { images.push(hit.blob); continue; }
      if (p.bg) await media.ready(p.bg);
      for (const o of objs) if (o.kind === 'image') await media.ready(o.media);
      // ~0.6 MP is plenty to read handwriting and uploads about half as much as before.
      const c = renderPageToCanvas(p, objs, Math.sqrt(600_000 / (p.w * p.h)));
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.8));
      c.width = c.height = 0;
      if (blob) { images.push(blob); this.pageImages.set(p.id, { sig, blob }); }
    }
    if (images.length) parts.push(`Attached: ${images.length} page image${images.length > 1 ? 's' : ''}, in order (${imgPages.map((p) => `page ${all.indexOf(p) + 1}`).join(', ')}).`);
    return { text: parts.join('\n\n'), images };
  }

  private async ask(prompt: string, label: string, scope: 'page' | 'note', _add?: string) {
    const sample = this.sample;
    if (!sample || this.busy) return;
    if (this.metered && this.credits.blockedUntil()) { this.renderCredits(); return; }
    this.toggle(true);
    const ctl = new AbortController();
    this.busy = ctl;
    const user: Turn = { role: 'user', content: prompt, label };
    const bot: Turn = { role: 'assistant', content: '' };
    this.turns.push(user, bot);
    this.renderLog();
    const bubble = () => this.log.querySelectorAll('.inkly-msg.bot .bubble')[this.log.querySelectorAll('.inkly-msg.bot .bubble').length - 1] as HTMLElement | undefined;
    try {
      const limits = await sample.limits().catch(() => null);
      const ctx = await this.gather(scope, limits?.images?.maxCount ?? 0);
      // Standing instructions + note context lead; history keeps the last turns.
      const history = this.turns.slice(0, -2).filter((t) => !t.failed && t.content).slice(-12).map((t) => ({ role: t.role, content: t.content }));
      const input = [
        { role: 'user' as Role, content: `${RULES}\n\n---\nTHE NOTE\n${ctx.text}` },
        ...history,
        { role: 'user' as Role, content: prompt },
      ];
      const deep = label === 'Study guide' || label === 'Flashcards';
      const { text, truncated } = await sample(input, {
        signal: ctl.signal,
        cache: false,
        ...(this.sample?.provider === 'Claude' ? {} : { speed: deep ? 'quality' : 'fast' }),
        ...(ctx.images.length ? { images: ctx.images } : {}),
        onText: ({ text }: { text: string }) => { bot.content = text; const b = bubble(); if (b) b.innerHTML = renderMd(text); this.log.scrollTop = this.log.scrollHeight; },
      });
      bot.content = text + (truncated ? '\n\n_(Cut short — ask for a smaller piece.)_' : '');
      if (this.metered) this.credits.spend();
    } catch (e) {
      const err = e as SampleErr;
      if (err.code === 'cancelled') bot.content = err.text ? `${err.text}\n\n(stopped)` : '';
      else {
        bot.content = err.text ? `${err.text}\n\n—\n${ERRORS[err.code ?? ''] ?? ERRORS.upstream_error}` : ERRORS[err.code ?? ''] ?? ERRORS.upstream_error;
        bot.failed = !err.text;
        if (err.code === 'passcode') this.askPasscode();
        if (err.code === 'rate_limited' && this.metered) {
          this.credits.blockFor(err.retryAfter, !!err.daily);
          const until = this.credits.blockedUntil();
          if (until) bot.content = `Google’s free limit is used up for now. Inkly will be back in ${formatWait(until - Date.now())}.`;
        }
      }
      if (!bot.content) this.turns.splice(this.turns.indexOf(user), 2);
    } finally {
      this.busy = null;
      this.save();
      this.renderLog();
    }
  }

  /** Write an answer into the note as new pages of typed text right after the current page. */
  private addToNote(md: string, label: string) {
    const ed = this.ed;
    const cur = ed.currentPage().page;
    const t = ed.timeline();
    const margin = 54;
    const blocks: { text: string; size: number; bold: boolean; gap: number }[] = [
      { text: label === 'Study guide' ? `Study guide — ${ed.meta.title}` : `${label} — ${ed.meta.title}`, size: 24, bold: true, gap: 14 },
    ];
    // One block per line so long answers break cleanly across pages.
    for (const raw of md.split('\n')) {
      const l = raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/_\((.*)\)_/, '($1)').trimEnd();
      const m = l.match(/^#{1,4}\s+(.*)/);
      if (m) { blocks.push({ text: m[1], size: 17, bold: true, gap: 6 }); continue; }
      if (!l.trim()) { if (blocks.length) blocks[blocks.length - 1].gap = Math.max(blocks[blocks.length - 1].gap, 12); continue; }
      blocks.push({ text: l.replace(/^\s*[-*]\s+/, '•  '), size: 14, bold: false, gap: 4 });
    }

    const ops: Op[] = [];
    let page: Page = { ...newPage(cur), id: uid(), template: 'blank', bg: undefined };
    let after = cur.id;
    ops.push({ t: 'addPage', page, after });
    let y = margin;
    const first = page.id;
    const width = page.w - margin * 2;
    for (const b of blocks) {
      // Estimate wrapped height (≈0.52em per character for the UI sans).
      const perLine = Math.max(10, Math.floor(width / (b.size * 0.52)));
      const lines = b.text.split('\n').reduce((n, s) => n + Math.max(1, Math.ceil(s.length / perLine)), 0);
      const hgt = lines * b.size * 1.3;
      if (y + hgt > page.h - margin && y > margin) {
        after = page.id;
        page = { ...page, id: uid() };
        ops.push({ t: 'addPage', page, after });
        y = margin;
      }
      const obj: TextObj = { kind: 'text', id: uid(), page: page.id, createdAt: t, x: margin, y, w: width, h: hgt, text: b.text, size: b.size, color: '#1c1917', bold: b.bold, font: 'sans' };
      ops.push({ t: 'add', obj });
      y += hgt + b.gap;
    }
    ed.doc.commit(ops);
    const pv = ed.pageView(first);
    if (pv) ed.scrollToPage(pv);
    if (window.innerWidth < 900) this.toggle(false);
  }
}
