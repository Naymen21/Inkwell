// App settings sheet: section list on the left, grouped toggle rows on the right.
import { PAPER_COLORS, applyAppearance, saveSettings, settings, type Appearance } from '../editor/settings';
import type { Template } from '../model/types';
import { icons } from './icons';
import { esc, sheet } from './modal';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

type Section = 'appearance' | 'editor' | 'paper' | 'about';

export function openSettings(onChange?: () => void) {
  let section: Section = 'appearance';
  sheet((box, close) => {
    const nav = h('nav', 'set-nav');
    const body = h('div', 'set-body');
    const head = h('div', 'set-head');
    const title = h('h3');
    const done = h('button', 'link-btn', 'Done');
    done.onclick = close;
    head.append(title, done);
    const pane = h('div', 'set-pane');
    body.append(head, pane);
    box.append(nav, body);

    const changed = () => { saveSettings(); onChange?.(); };
    const row = (label: string, desc: string, value: boolean, set: (v: boolean) => void) => {
      const r = h('label', 'set-row');
      r.innerHTML = `<span class="set-text"><span class="set-label">${esc(label)}</span><span class="set-desc">${esc(desc)}</span></span>`;
      const sw = h('input', 'switch');
      sw.type = 'checkbox';
      sw.checked = value;
      sw.onchange = () => { set(sw.checked); changed(); };
      r.append(sw);
      return r;
    };

    const sections: [Section, string, string][] = [
      ['appearance', 'Appearance', icons.palette],
      ['editor', 'Handwriting & drawing', icons.pen],
      ['paper', 'Paper', icons.page],
      ['about', 'About', icons.notes],
    ];
    const render = () => {
      nav.innerHTML = '';
      for (const [id, label, icon] of sections) {
        const b = h('button', `set-nav-item${section === id ? ' on' : ''}`, `${icon}<span>${label}</span>`);
        b.onclick = () => { section = id; render(); };
        nav.append(b);
      }
      title.textContent = sections.find((s) => s[0] === section)![1];
      pane.innerHTML = '';
      if (section === 'appearance') {
        const g = h('div', 'set-group pad');
        const row = h('div', 'theme-row');
        for (const [v, l] of [['light', 'Light'], ['dark', 'Dark'], ['system', 'Automatic']] as [Appearance, string][]) {
          const b = h('button', `theme-opt${settings.appearance === v ? ' on' : ''}`, `<span class="theme-prev ${v}"><i></i><i></i><i></i></span><span>${l}</span>`);
          b.onclick = () => { settings.appearance = v; applyAppearance(); changed(); render(); };
          row.append(b);
        }
        g.append(row);
        pane.append(g, h('p', 'set-note', 'Automatic follows your device’s light or dark setting. Your pages stay the paper color you picked.'));
      } else if (section === 'editor') {
        const g = h('div', 'set-group');
        g.append(
          row('Straight lines', 'Highlighter strokes that are nearly straight snap to a perfect line.', settings.straightLines, (v) => (settings.straightLines = v)),
          row('Shape detection', 'Draw a shape and hold the pen still at the end to snap it into a clean shape.', settings.holdToSnap, (v) => (settings.holdToSnap = v)),
          row('Palm detection', 'Only the pencil (or mouse) writes. Fingers scroll and zoom, so you can rest your hand on the screen.', !settings.fingerDraw, (v) => (settings.fingerDraw = !v)),
          row('Pressure sensitivity', 'Pen lines get thicker the harder you press.', settings.pen.pressure, (v) => (settings.pen.pressure = v)),
          (() => {
            const r = h('label', 'set-row');
            r.innerHTML = '<span class="set-text"><span class="set-label">Inkly credits per day</span><span class="set-desc">Answers Inkly can give per day on this device. Resets at midnight Pacific. 250 keeps two people with two devices each inside Google’s free limit. (Inside Claude it uses your Claude plan instead.)</span></span>';
            const n = h('input', 'num-field');
            n.type = 'number'; n.min = '1'; n.max = '1000'; n.step = '5';
            n.value = String(settings.inklyDailyCredits);
            n.setAttribute('aria-label', 'Inkly credits per day');
            n.onchange = () => { settings.inklyDailyCredits = Math.max(1, Math.min(1000, Math.round(Number(n.value) || 250))); n.value = String(settings.inklyDailyCredits); changed(); };
            r.append(n);
            return r;
          })(),
          row('Auto-deselect eraser', 'After erasing, switch back to the tool you were using.', settings.autoDeselectEraser, (v) => (settings.autoDeselectEraser = v)),
        );
        pane.append(g);
      } else if (section === 'paper') {
        pane.append(h('div', 'set-caption', 'New notes start with'));
        const g = h('div', 'set-group pad');
        const tpl = h('div', 'paper-row');
        for (const [t, label] of [['blank', 'Blank'], ['lined', 'Lined'], ['grid', 'Grid'], ['dotted', 'Dotted']] as [Template, string][]) {
          const b = h('button', `paper-opt${settings.paper.template === t ? ' on' : ''}`, `<span class="paper-prev ${t}" style="--paper:${settings.paper.color}"></span>${label}`);
          b.onclick = () => { settings.paper.template = t; changed(); render(); };
          tpl.append(b);
        }
        const col = h('div', 'paper-row');
        for (const c of PAPER_COLORS) {
          const b = h('button', `swatch big${settings.paper.color === c ? ' on' : ''}`);
          b.style.setProperty('--c', c);
          b.onclick = () => { settings.paper.color = c; changed(); render(); };
          col.append(b);
        }
        const seg = h('div', 'segmented');
        for (const [v, l] of [['letter', 'US Letter'], ['a4', 'A4']] as const) {
          const b = h('button', settings.paper.size === v ? 'on' : '', l);
          b.onclick = () => { settings.paper.size = v; changed(); render(); };
          seg.append(b);
        }
        g.append(tpl, h('div', 'set-sub', 'Color'), col, h('div', 'set-sub', 'Size'), seg);
        pane.append(g);
      } else {
        const g = h('div', 'set-group pad');
        g.innerHTML = '<p><b>Inkwell</b> — handwritten notes with synced audio.</p><p class="muted">Notes are stored on this device only. Use “Export note file” to move a note to another device.</p><p class="muted storage">Checking storage…</p>';
        pane.append(g);
        navigator.storage?.estimate?.().then((e) => {
          const mb = (n?: number) => `${((n ?? 0) / 1e6).toFixed(1)} MB`;
          const s = g.querySelector('.storage');
          if (s) s.textContent = `Using ${mb(e.usage)} of ${mb(e.quota)} available.`;
        });
      }
    };
    render();
  }, undefined, 'settings');
}
