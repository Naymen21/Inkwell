// Library: dividers → subjects → notes, search, import, trash.
import type { Folder, NoteMeta } from '../model/types';
import { db } from '../persist/db';
import { createNote } from '../editor/editor';
import { exportNoteFile, importNoteFile, pdfToPages, safeName, saveBlob } from '../editor/io';
import { icons } from '../ui/icons';
import { busy, confirmBox, esc, menu, promptText, toast } from '../ui/modal';
import { uid } from '../util/ids';

type Filter = 'all' | 'unfiled' | 'trash' | string;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

const state = {
  filter: (localStorage.getItem('inkwell.filter') as Filter | null) ?? 'all',
  sort: (localStorage.getItem('inkwell.sort') as 'modified' | 'created' | 'title' | null) ?? 'modified',
  query: '',
  collapsed: new Set<string>(),
};

const TRASH_DAYS = 30;

export async function renderLibrary(mount: HTMLElement, open: (id: string) => void) {
  const root = h('div', 'library');
  mount.append(root);
  let notes: NoteMeta[] = [];
  let folders: Folder[] = [];

  // Empty the trash of anything older than 30 days.
  const cutoff = Date.now() - TRASH_DAYS * 864e5;
  for (const n of await db.listNotes()) if (n.trashed && n.trashed < cutoff) await db.deleteNote(n.id);

  const side = h('aside', 'lib-side');
  const main = h('main', 'lib-main');
  const scrim = h('div', 'lib-scrim');
  scrim.onclick = () => root.classList.remove('side-open');
  root.append(side, scrim, main);

  const header = h('header', 'lib-head');
  const menuBtn = h('button', 'icon-btn lib-menu', icons.menu);
  menuBtn.onclick = () => root.classList.toggle('side-open');
  const title = h('h1', 'lib-title');
  const search = h('div', 'search');
  const q = h('input');
  q.type = 'search';
  q.placeholder = 'Search notes';
  q.value = state.query;
  q.oninput = () => { state.query = q.value; drawGrid(); };
  search.append(h('span', '', icons.search), q);
  const sort = h('select', 'select');
  for (const [v, l] of [['modified', 'Date modified'], ['created', 'Date created'], ['title', 'Title']]) {
    const o = h('option', '', l); o.value = v; sort.append(o);
  }
  sort.value = state.sort;
  sort.onchange = () => { state.sort = sort.value as typeof state.sort; localStorage.setItem('inkwell.sort', state.sort); drawGrid(); };
  const importBtn = h('button', 'btn', `${icons.upload}<span>Import</span>`);
  importBtn.onclick = () => importFlow();
  const newBtn = h('button', 'btn primary', `${icons.plus}<span>New note</span>`);
  newBtn.onclick = async () => {
    const f = state.filter;
    const folder = f === 'all' || f === 'unfiled' || f === 'trash' ? null : f;
    const n = await createNote(folder);
    open(n.id);
  };
  header.append(menuBtn, title, search, sort, importBtn, newBtn);
  const grid = h('div', 'grid');
  main.append(header, grid);

  async function reload() {
    [notes, folders] = await Promise.all([db.listNotes(), db.listFolders()]);
    if (!['all', 'unfiled', 'trash'].includes(state.filter) && !folders.some((f) => f.id === state.filter)) state.filter = 'all';
    drawSide();
    drawGrid();
  }

  const setFilter = (f: Filter) => {
    state.filter = f;
    localStorage.setItem('inkwell.filter', f);
    root.classList.remove('side-open');
    drawSide();
    drawGrid();
  };

  const dividers = () => folders.filter((f) => !f.parent).sort((a, b) => a.created - b.created);
  const subjects = (d: string) => folders.filter((f) => f.parent === d).sort((a, b) => a.created - b.created);
  const live = () => notes.filter((n) => !n.trashed);
  const countIn = (fid: string) => {
    const ids = new Set([fid, ...subjects(fid).map((s) => s.id)]);
    return live().filter((n) => n.folder && ids.has(n.folder)).length;
  };

  function drawSide() {
    side.innerHTML = '';
    side.append(h('div', 'brand', `<span class="brand-mark">${icons.pen}</span>Inkwell`));
    const nav = h('nav', 'lib-nav');
    const item = (f: Filter, icon: string, label: string, count?: number, cls = '') => {
      const b = h('button', `nav-item ${cls}${state.filter === f ? ' on' : ''}`, `<span class="ni-icon">${icon}</span><span class="ni-label">${esc(label)}</span>${count != null ? `<span class="ni-count">${count}</span>` : ''}`);
      b.onclick = () => setFilter(f);
      return b;
    };
    nav.append(item('all', icons.notes, 'All notes', live().length));
    nav.append(item('unfiled', icons.inbox, 'Unfiled', live().filter((n) => !n.folder || !folders.some((f) => f.id === n.folder)).length));
    nav.append(h('div', 'nav-head', '<span>Dividers</span>'));
    const addDiv = h('button', 'icon-btn small', icons.plus);
    addDiv.title = 'New divider';
    addDiv.onclick = async () => {
      const name = await promptText('New divider', '', 'Create');
      if (!name) return;
      await db.putFolder({ id: uid(), name, parent: null, created: Date.now() });
      reload();
    };
    nav.lastElementChild!.append(addDiv);
    for (const d of dividers()) {
      const wrap = h('div', 'divider');
      const head = item(d.id, icons.folder, d.name, countIn(d.id), 'div-item');
      const more = h('span', 'ni-more', icons.more);
      more.onclick = (e) => { e.stopPropagation(); folderMenu(d, more); };
      head.append(more);
      wrap.append(head);
      const subs = subjects(d.id);
      if (!state.collapsed.has(d.id)) {
        for (const s of subs) {
          const si = item(s.id, '', s.name, live().filter((n) => n.folder === s.id).length, 'sub-item');
          const sm = h('span', 'ni-more', icons.more);
          sm.onclick = (e) => { e.stopPropagation(); folderMenu(s, sm); };
          si.append(sm);
          wrap.append(si);
        }
        const add = h('button', 'nav-add', '+ Subject');
        add.onclick = async () => {
          const name = await promptText(`New subject in ${d.name}`, '', 'Create');
          if (!name) return;
          await db.putFolder({ id: uid(), name, parent: d.id, created: Date.now() });
          reload();
        };
        wrap.append(add);
      }
      nav.append(wrap);
    }
    if (!dividers().length) nav.append(h('p', 'nav-empty', 'Create a divider (e.g. "Fall semester"), then subjects inside it (e.g. "AP Lit").'));
    nav.append(h('div', 'nav-spacer'));
    nav.append(item('trash', icons.trash, 'Recently deleted', notes.filter((n) => n.trashed).length));
    side.append(nav);
  }

  function folderMenu(f: Folder, anchor: HTMLElement) {
    menu([
      { label: 'Rename', action: async () => {
        const name = await promptText('Rename', f.name);
        if (name) { await db.putFolder({ ...f, name }); reload(); }
      } },
      ...(!f.parent ? [{ label: state.collapsed.has(f.id) ? 'Expand' : 'Collapse', action: () => {
        state.collapsed.has(f.id) ? state.collapsed.delete(f.id) : state.collapsed.add(f.id);
        drawSide();
      } }] : []),
      { label: 'Delete', danger: true, action: async () => {
        const ids = new Set([f.id, ...(f.parent ? [] : subjects(f.id).map((s) => s.id))]);
        const n = notes.filter((x) => x.folder && ids.has(x.folder)).length;
        if (!(await confirmBox(`Delete “${f.name}”?`, n ? `${n} note${n > 1 ? 's' : ''} inside will move to Unfiled.` : 'It is empty.'))) return;
        for (const note of notes) if (note.folder && ids.has(note.folder)) await db.putNote({ ...note, folder: null });
        for (const id of ids) await db.deleteFolder(id);
        reload();
      } },
    ], anchor, f.name);
  }

  function filtered(): NoteMeta[] {
    const f = state.filter;
    let list = f === 'trash' ? notes.filter((n) => n.trashed) : live();
    if (f === 'unfiled') list = list.filter((n) => !n.folder || !folders.some((x) => x.id === n.folder));
    else if (f !== 'all' && f !== 'trash') {
      const ids = new Set([f, ...subjects(f).map((s) => s.id)]);
      list = list.filter((n) => n.folder && ids.has(n.folder));
    }
    const qq = state.query.trim().toLowerCase();
    if (qq) list = list.filter((n) => n.title.toLowerCase().includes(qq) || (n.searchText ?? '').toLowerCase().includes(qq));
    const s = state.sort;
    return list.sort((a, b) => (s === 'title' ? a.title.localeCompare(b.title) : (b[s] ?? 0) - (a[s] ?? 0)));
  }

  const folderName = (id: string | null) => {
    const f = folders.find((x) => x.id === id);
    if (!f) return '';
    const p = f.parent ? folders.find((x) => x.id === f.parent) : null;
    return p ? `${p.name} › ${f.name}` : f.name;
  };

  function drawGrid() {
    const f = state.filter;
    title.textContent = f === 'all' ? 'All notes' : f === 'unfiled' ? 'Unfiled' : f === 'trash' ? 'Recently deleted' : folderName(f);
    newBtn.style.display = f === 'trash' ? 'none' : '';
    grid.innerHTML = '';
    const list = filtered();
    if (!list.length) {
      grid.append(h('div', 'empty', f === 'trash'
        ? `<p>Nothing here. Deleted notes stay for ${TRASH_DAYS} days.</p>`
        : state.query ? '<p>No notes match your search.</p>' : `<div class="empty-art">${icons.notes}</div><p>No notes yet.</p><p class="muted">Tap <b>New note</b> to start writing, or <b>Import</b> a PDF to annotate.</p>`));
      return;
    }
    for (const n of list) {
      const card = h('div', 'card');
      card.tabIndex = 0;
      const thumb = h('div', 'card-thumb');
      if (n.thumb) { const img = h('img'); img.src = n.thumb; img.alt = ''; img.loading = 'lazy'; thumb.append(img); }
      if (n.clips?.length) thumb.append(h('span', 'card-audio', icons.mic));
      const meta = h('div', 'card-meta');
      const date = new Date(n.modified).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(n.modified).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
      meta.innerHTML = `<div class="card-title">${esc(n.title)}</div><div class="card-sub">${esc(date)}${n.pageCount ? ` · ${n.pageCount} pg` : ''}${f === 'all' && n.folder ? ` · ${esc(folderName(n.folder))}` : ''}</div>`;
      const more = h('button', 'icon-btn card-more', icons.more);
      more.onclick = (e) => { e.stopPropagation(); noteMenu(n, more); };
      meta.append(more);
      card.append(thumb, meta);
      card.onclick = () => { if (!n.trashed) open(n.id); else noteMenu(n, more); };
      card.onkeydown = (e) => { if (e.key === 'Enter') card.click(); };
      grid.append(card);
    }
  }

  function noteMenu(n: NoteMeta, anchor: HTMLElement) {
    if (n.trashed) {
      menu([
        { label: 'Restore', icon: icons.restore, action: async () => { await db.putNote({ ...n, trashed: undefined }); reload(); } },
        { label: 'Delete forever', icon: icons.trash, danger: true, action: async () => {
          if (await confirmBox('Delete forever?', 'This note and its recordings will be permanently removed.')) { await db.deleteNote(n.id); reload(); }
        } },
      ], anchor, n.title);
      return;
    }
    menu([
      { label: 'Rename', action: async () => {
        const t = await promptText('Rename note', n.title);
        if (t) { await db.putNote({ ...n, title: t }); reload(); }
      } },
      { label: 'Move to…', icon: icons.folder, action: () => moveMenu(n, anchor) },
      { label: 'Export note file', icon: icons.download, action: async () => {
        try { await saveBlob(await exportNoteFile(n), `${safeName(n.title)}.inkwell`); } catch (e) { console.error(e); toast('Export failed'); }
      } },
      { label: 'Delete', icon: icons.trash, danger: true, action: async () => {
        await db.putNote({ ...n, trashed: Date.now() });
        toast('Moved to Recently deleted');
        reload();
      } },
    ], anchor, n.title);
  }

  function moveMenu(n: NoteMeta, anchor: HTMLElement) {
    const items = [{ label: 'Unfiled', checked: !n.folder, action: () => move(null) }];
    for (const d of dividers()) {
      items.push({ label: d.name, checked: n.folder === d.id, action: () => move(d.id) });
      for (const s of subjects(d.id)) items.push({ label: `   ${s.name}`, checked: n.folder === s.id, action: () => move(s.id) });
    }
    async function move(folder: string | null) { await db.putNote({ ...n, folder }); reload(); }
    menu(items, anchor, 'Move to');
  }

  async function importFlow() {
    const i = h('input');
    i.type = 'file';
    i.accept = '.pdf,application/pdf,.inkwell,application/json';
    i.multiple = true;
    i.onchange = async () => {
      const f = state.filter;
      const folder = f === 'all' || f === 'unfiled' || f === 'trash' ? null : f;
      let last: string | null = null;
      for (const file of i.files ?? []) {
        const b = busy(`Importing ${file.name}…`);
        try {
          if (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf') {
            const pages = await pdfToPages(file, (d, t) => b.set(`Importing ${file.name} — page ${Math.min(d + 1, t)} of ${t}`));
            last = (await createNote(folder, file.name.replace(/\.pdf$/i, ''), pages)).id;
          } else {
            last = (await importNoteFile(file, folder)).id;
          }
        } catch (e) {
          console.error(e);
          toast(`Could not import ${file.name}`);
        } finally { b.done(); }
      }
      if (last && (i.files?.length ?? 0) === 1) open(last);
      else reload();
    };
    i.click();
  }

  // Drag & drop files onto the library.
  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    for (const file of files) {
      if (!/\.(pdf|inkwell)$/i.test(file.name)) continue;
      const b = busy(`Importing ${file.name}…`);
      try {
        if (/\.pdf$/i.test(file.name)) await createNote(null, file.name.replace(/\.pdf$/i, ''), await pdfToPages(file, () => {}));
        else await importNoteFile(file, null);
      } catch (err) { console.error(err); toast(`Could not import ${file.name}`); }
      finally { b.done(); }
    }
    reload();
  });

  await reload();
  return () => root.remove();
}
