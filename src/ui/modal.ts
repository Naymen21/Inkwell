// Small in-app dialogs (native prompt/confirm look out of place on iPad and
// block the page).

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function sheet(build: (box: HTMLDivElement, close: () => void) => void, onDismiss?: () => void) {
  const back = el('div', 'modal-back');
  const box = el('div', 'modal');
  back.append(box);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.classList.add('out');
    setTimeout(() => back.remove(), 150);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); onDismiss?.(); } };
  back.addEventListener('pointerdown', (e) => { if (e.target === back) { close(); onDismiss?.(); } });
  document.addEventListener('keydown', onKey);
  build(box, close);
  document.body.append(back);
  return close;
}

export function promptText(title: string, value = '', ok = 'Save'): Promise<string | null> {
  return new Promise((resolve) => {
    sheet((box, close) => {
      box.append(el('h3', '', esc(title)));
      const input = el('input', 'field');
      input.value = value;
      const row = el('div', 'modal-actions');
      const cancel = el('button', 'btn', 'Cancel');
      const okb = el('button', 'btn primary', esc(ok));
      row.append(cancel, okb);
      box.append(input, row);
      const done = (v: string | null) => { close(); resolve(v); };
      cancel.onclick = () => done(null);
      okb.onclick = () => done(input.value.trim() || null);
      input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value.trim() || null); };
      setTimeout(() => { input.focus(); input.select(); }, 30);
    }, () => resolve(null));
  });
}

export function confirmBox(title: string, body: string, ok = 'Delete', danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    sheet((box, close) => {
      box.append(el('h3', '', esc(title)), el('p', 'muted', esc(body)));
      const row = el('div', 'modal-actions');
      const cancel = el('button', 'btn', 'Cancel');
      const okb = el('button', `btn ${danger ? 'danger' : 'primary'}`, esc(ok));
      row.append(cancel, okb);
      box.append(row);
      cancel.onclick = () => { close(); resolve(false); };
      okb.onclick = () => { close(); resolve(true); };
    }, () => resolve(false));
  });
}

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  checked?: boolean;
  action: () => void;
}

/** Action sheet: a popover near `anchor` on wide screens, bottom sheet on phones. */
export function menu(items: (MenuItem | null)[], anchor?: HTMLElement, title?: string) {
  sheet((box, close) => {
    box.classList.add('menu');
    if (title) box.append(el('div', 'menu-title', esc(title)));
    for (const it of items) {
      if (!it) { box.append(el('div', 'menu-sep')); continue; }
      const b = el('button', `menu-item${it.danger ? ' danger' : ''}`);
      b.innerHTML = `<span class="mi-icon">${it.icon ?? ''}</span><span class="mi-label">${esc(it.label)}</span>${it.checked ? '<span class="mi-check">✓</span>' : ''}`;
      b.onclick = () => { close(); it.action(); };
      box.append(b);
    }
    if (anchor && window.innerWidth > 600) {
      const r = anchor.getBoundingClientRect();
      box.classList.add('pop');
      requestAnimationFrame(() => {
        const bw = box.offsetWidth, bh = box.offsetHeight;
        let left = Math.min(window.innerWidth - bw - 8, Math.max(8, r.left + r.width / 2 - bw / 2));
        let top = r.bottom + 6;
        if (top + bh > window.innerHeight - 8) top = Math.max(8, r.top - bh - 6);
        Object.assign(box.style, { left: `${left}px`, top: `${top}px` });
      });
    }
  });
}

/** Generic custom-content sheet. */
export function panel(title: string, build: (body: HTMLDivElement, close: () => void) => void) {
  sheet((box, close) => {
    const head = el('div', 'panel-head');
    head.append(el('h3', '', esc(title)));
    const x = el('button', 'icon-btn', '×');
    x.onclick = close;
    head.append(x);
    const body = el('div', 'panel-body');
    box.append(head, body);
    build(body, close);
  });
}

let toastTimer = 0;
export function toast(msg: string, ms = 2600) {
  let t = document.querySelector<HTMLDivElement>('.toast');
  if (!t) { t = el('div', 'toast'); document.body.append(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), ms);
}

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function busy(msg: string) {
  const b = el('div', 'busy', `<div class="spinner"></div><div class="busy-msg">${esc(msg)}</div>`);
  document.body.append(b);
  return {
    set(m: string) { b.querySelector('.busy-msg')!.textContent = m; },
    done() { b.remove(); },
  };
}
