// Library: folders → subfolders → notes, search, import, trash.
import type { Folder, NoteMeta } from '../model/types';
import { db } from '../persist/db';
import { createNote } from '../editor/editor';
import { exportNoteFile, importNoteFile, pdfToPages, safeName, saveBlob } from '../editor/io';
import { icons } from '../ui/icons';
import { busy, confirmBox, esc, menu, promptText, toast } from '../ui/modal';
import { openSettings } from '../ui/settingsPanel';
import { uid } from '../util/ids';
import { pickFiles } from '../ui/pickFiles';
import { makeDraggable } from './dragNotes';

type Filter = 'all' | 'unfiled' | 'trash' | string;
type Sort = 'modified' | 'created' | 'title';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export const FOLDER_COLORS = ['#f76b15', '#30a46c', '#e2b203', '#3e7bfa', '#e5484d', '#8e4ec6', '#12a594', '#d6409f'];

const state = {
  filter: (localStorage.getItem('inkwell.filter') as Filter | null) ?? 'all',
  sort: (localStorage.getItem('inkwell.sort') as Sort | null) ?? 'modified',
  query: '',
  collapsed: new Set<string>(),
};

const TRASH_DAYS = 30;

export async function renderLibrary(mount: HTMLElement, open: (id: string) => void) {
  const root = h('div', 'library');
  mount.append(root);
  let notes: NoteMeta[] = [];
  let folders: Folder[] = [];

  // Purge trash older than 30 days.
  const cutoff = Date.now() - TRASH_DAYS * 864e5;
  for (const n of await db.listNotes()) if (n.trashed && n.trashed < cutoff) await db.deleteNote(n.id);

  const side = h('aside', 'lib-side');
  const main = h('main', 'lib-main');
  const scrim = h('div', 'lib-scrim');
  scrim.onclick = () => root.classList.remove('side-open');
  root.append(side, scrim, main);

  // Sidebar: settings + search sit above the navigation and never re-render (keeps focus).
  const sideTop = h('div', 'side-top');
  sideTop.append(h('div', 'brand', `<span class="brand-mark">${icons.logo}</span>Inkwell`));
  const gear = h('button', 'icon-btn', icons.gear);
  gear.title = 'Settings';
  gear.setAttribute('aria-label', 'Settings');
  gear.onclick = () => openSettings();
  sideTop.append(gear);
  const search = h('label', 'search');
  const q = h('input');
  q.type = 'search';
  q.placeholder = 'Search';
  q.setAttribute('aria-label', 'Search notes');
  q.value = state.query;
  q.oninput = () => { state.query = q.value; drawGrid(); };
  search.append(h('span', '', icons.search), q);
  const nav = h('nav', 'lib-nav');
  side.append(sideTop, search, nav);

  const header = h('header', 'lib-head');
  const menuBtn = h('button', 'icon-btn lib-menu', icons.menu);
  menuBtn.setAttribute('aria-label', 'Folders');
  menuBtn.onclick = () => root.classList.toggle('side-open');
  const title = h('h1', 'lib-title');
  const sub = h('div', 'lib-sub');
  const heading = h('div', 'lib-heading');
  heading.append(title, sub);
  const moreBtn = h('button', 'icon-btn', icons.nbMore);
  moreBtn.setAttribute('aria-label', 'Sort and import');
  moreBtn.onclick = () => libMenu(moreBtn);
  const newBtn = h('button', 'new-btn', `${icons.plus}<span>New</span>`);
  newBtn.onclick = async () => {
    try {
      const n = await createNote(currentFolder());
      open(n.id);
    } catch (e) {
      storageFailed(e);
    }
  };
  header.append(menuBtn, heading, moreBtn, newBtn);
  const grid = h('div', 'grid');
  main.append(header, grid);

  const currentFolder = () => (['all', 'unfiled', 'trash'].includes(state.filter) ? null : state.filter);

  /** Storage problems are the one failure every action shares; say so plainly. */
  function storageFailed(e: unknown) {
    console.error(e);
    const msg = e instanceof Error ? e.message : String(e);
    toast(`Couldn’t save on this device. ${msg}`, 6000);
  }

  async function reload() {
    try {
      [notes, folders] = await Promise.all([db.listNotes(), db.listFolders()]);
    } catch (e) {
      grid.replaceChildren(h('div', 'empty storage-blocked', `<div class="empty-art">${icons.notes}</div>
        <p><b>Inkwell can’t save notes in this browser</b></p>
        <p class="muted">${esc(e instanceof Error ? e.message : String(e))}</p>
        <p class="muted">On iPad: turn off Private Browsing, or open Inkwell in Safari directly (not inside another app). Settings › Safari › Advanced › “Block All Cookies” also blocks storage.</p>`));
      return;
    }
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

  const tops = () => folders.filter((f) => !f.parent).sort((a, b) => a.created - b.created);
  const subs = (d: string) => folders.filter((f) => f.parent === d).sort((a, b) => a.created - b.created);
  const live = () => notes.filter((n) => !n.trashed);
  const colorOf = (f: Folder) => f.color ?? FOLDER_COLORS[tops().concat(folders).indexOf(f) % FOLDER_COLORS.length];
  /** A folder and everything nested under it, at any depth. */
  const descendants = (fid: string): Set<string> => {
    const out = new Set([fid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of folders) if (f.parent && out.has(f.parent) && !out.has(f.id)) { out.add(f.id); grew = true; }
    }
    return out;
  };
  const countIn = (fid: string) => {
    const ids = descendants(fid);
    return live().filter((n) => n.folder && ids.has(n.folder)).length;
  };
  /** Folders as a flat, depth-first list with their depth (for menus). */
  const tree = (): { f: Folder; depth: number }[] => {
    const out: { f: Folder; depth: number }[] = [];
    const walk = (list: Folder[], depth: number) => { for (const f of list) { out.push({ f, depth }); walk(subs(f.id), depth + 1); } };
    walk(tops(), 0);
    return out;
  };

  function drawSide() {
    nav.innerHTML = '';
    const item = (f: Filter, icon: string, label: string, count?: number, cls = '') => {
      const b = h('button', `nav-item ${cls}${state.filter === f ? ' on' : ''}`, `<span class="ni-icon">${icon}</span><span class="ni-label">${esc(label)}</span>${count != null ? `<span class="ni-count">${count}</span>` : ''}`);
      b.onclick = () => setFilter(f);
      // Every destination except "all notes" accepts a dragged note.
      if (f !== 'all') b.dataset.drop = f;
      return b;
    };
    nav.append(item('all', icons.nbNotes, 'Notes', live().length));
    nav.append(item('unfiled', icons.inbox, 'Unfiled', live().filter((n) => !n.folder || !folders.some((f) => f.id === n.folder)).length));

    const head = h('div', 'nav-head', '<span>Folders</span>');
    const add = h('button', 'icon-btn small', icons.plus);
    add.title = 'New folder';
    add.setAttribute('aria-label', 'New folder');
    add.onclick = async () => {
      const name = await promptText('New folder', '', 'Create');
      if (!name) return;
      try {
        await db.putFolder({ id: uid(), name, parent: null, created: Date.now(), color: FOLDER_COLORS[tops().length % FOLDER_COLORS.length] });
      } catch (e) { storageFailed(e); return; }
      reload();
    };
    head.append(add);
    nav.append(head);

    // Folders nest to any depth; each level indents a little more.
    const drawFolder = (d: Folder, depth: number) => {
      const dot = `<span class="f-dot" style="--f:${colorOf(d)}"></span>`;
      const row = item(d.id, dot, d.name, countIn(d.id), depth ? 'folder-item sub-item' : 'folder-item');
      row.style.paddingLeft = `${10 + Math.min(depth, 6) * 16}px`;
      const children = subs(d.id);
      const more = h('span', 'ni-more', icons.more);
      more.onclick = (e) => { e.stopPropagation(); folderMenu(d, more); };
      row.append(more);
      // Disclosure chevron on the right, as in Notability.
      if (children.length) {
        const caret = h('span', `caret${state.collapsed.has(d.id) ? '' : ' open'}`, icons.chevronRight);
        caret.onclick = (e) => {
          e.stopPropagation();
          state.collapsed.has(d.id) ? state.collapsed.delete(d.id) : state.collapsed.add(d.id);
          drawSide();
        };
        row.append(caret);
      }
      nav.append(row);
      if (!state.collapsed.has(d.id)) for (const c of children) drawFolder(c, depth + 1);
    };
    for (const d of tops()) drawFolder(d, 0);
    if (!tops().length) nav.append(h('p', 'nav-empty', 'Tap + to make a folder, e.g. “AP Lit”. Folders can hold subfolders.'));
    nav.append(h('div', 'nav-spacer'));
    nav.append(item('trash', icons.trash, 'Recently deleted', notes.filter((n) => n.trashed).length));
  }

  function folderMenu(f: Folder, anchor: HTMLElement) {
    menu([
      { label: 'New folder inside', icon: icons.plus, action: async () => {
        const name = await promptText(`New folder in ${f.name}`, '', 'Create');
        if (!name) return;
        try {
          await db.putFolder({ id: uid(), name, parent: f.id, created: Date.now(), color: FOLDER_COLORS[(subs(f.id).length + 2) % FOLDER_COLORS.length] });
        } catch (e) { storageFailed(e); return; }
        state.collapsed.delete(f.id);
        reload();
      } },
      { label: 'Move folder to…', icon: icons.folder, action: () => moveFolderMenu(f, anchor) },
      { label: 'Rename', action: async () => {
        const name = await promptText('Rename', f.name);
        if (name) { await db.putFolder({ ...f, name }); reload(); }
      } },
      { label: 'Color…', action: () => {
        menu(FOLDER_COLORS.map((c) => ({
          label: ' ', icon: `<span class="f-dot big" style="--f:${c}"></span>`, checked: colorOf(f) === c,
          action: async () => { await db.putFolder({ ...f, color: c }); reload(); },
        })), anchor, 'Folder color');
      } },
      { label: 'Delete', danger: true, icon: icons.trash, action: async () => {
        const ids = descendants(f.id);
        const n = notes.filter((x) => x.folder && ids.has(x.folder)).length;
        const inner = ids.size - 1;
        const what = [inner ? `${inner} folder${inner > 1 ? 's' : ''} inside will be deleted too.` : '', n ? `${n} note${n > 1 ? 's' : ''} will move to Unfiled.` : ''].filter(Boolean).join(' ') || 'It is empty.';
        if (!(await confirmBox(`Delete “${f.name}”?`, what))) return;
        for (const note of notes) if (note.folder && ids.has(note.folder)) await db.putNote({ ...note, folder: null });
        for (const id of ids) await db.deleteFolder(id);
        reload();
      } },
    ], anchor, f.name);
  }

  function libMenu(anchor: HTMLElement) {
    const sortItem = (s: Sort, label: string) => ({
      label, checked: state.sort === s, icon: icons.sort,
      action: () => { state.sort = s; localStorage.setItem('inkwell.sort', s); drawGrid(); },
    });
    menu([
      { label: 'Import PDF or note…', icon: icons.upload, action: () => importFlow() },
      null,
      sortItem('modified', 'Sort by date modified'),
      sortItem('created', 'Sort by date created'),
      sortItem('title', 'Sort by title'),
      null,
      { label: 'Settings', icon: icons.gear, action: () => openSettings() },
    ], anchor);
  }

  function filtered(): NoteMeta[] {
    const f = state.filter;
    let list = f === 'trash' ? notes.filter((n) => n.trashed) : live();
    if (f === 'unfiled') list = list.filter((n) => !n.folder || !folders.some((x) => x.id === n.folder));
    else if (f !== 'all' && f !== 'trash') {
      const ids = descendants(f);
      list = list.filter((n) => n.folder && ids.has(n.folder));
    }
    const qq = state.query.trim().toLowerCase();
    if (qq) list = list.filter((n) => n.title.toLowerCase().includes(qq) || (n.searchText ?? '').toLowerCase().includes(qq));
    const s = state.sort;
    return list.sort((a, b) => (s === 'title' ? a.title.localeCompare(b.title) : (b[s] ?? 0) - (a[s] ?? 0)));
  }

  const folderOf = (id: string | null) => folders.find((x) => x.id === id);

  function drawGrid() {
    const f = state.filter;
    title.textContent = f === 'all' ? 'All Notes' : f === 'unfiled' ? 'Unfiled' : f === 'trash' ? 'Recently Deleted' : folderOf(f)?.name ?? '';
    newBtn.style.display = f === 'trash' ? 'none' : '';
    grid.innerHTML = '';
    const list = filtered();
    sub.textContent = `${list.length} ${list.length === 1 ? 'note' : 'notes'}${state.query ? ' found' : ''}`;
    if (!list.length) {
      grid.append(h('div', 'empty', f === 'trash'
        ? `<p>Nothing here. Deleted notes stay for ${TRASH_DAYS} days.</p>`
        : state.query ? '<p>No notes match your search.</p>' : `<div class="empty-art">${icons.notes}</div><p><b>No notes yet</b></p><p class="muted">Tap <b>New</b> to start writing, or import a PDF from the ⋯ menu to annotate it.</p>`));
      return;
    }
    for (const n of list) {
      const card = h('div', 'card');
      card.tabIndex = 0;
      const tile = h('div', 'card-tile');
      const thumb = h('div', 'card-thumb');
      if (n.thumb) { const img = h('img'); img.src = n.thumb; img.alt = ''; img.loading = 'lazy'; thumb.append(img); }
      tile.append(thumb);
      if (n.clips?.length) tile.append(h('span', 'card-audio', icons.mic));
      const meta = h('div', 'card-meta');
      const d = new Date(n.modified);
      const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
      const fo = folderOf(n.folder);
      const tag = fo && f !== n.folder ? `<span class="tag" style="--f:${colorOf(fo)}">${esc(fo.name)}</span>` : '';
      meta.innerHTML = `<div class="card-title">${esc(n.title)}</div><div class="card-sub"><span>${esc(date)}</span>${tag}</div>`;
      const more = h('button', 'icon-btn card-more', icons.more);
      more.setAttribute('aria-label', `Options for ${n.title}`);
      more.onclick = (e) => { e.stopPropagation(); noteMenu(n, more); };
      meta.append(more);
      card.append(tile, meta);
      card.onclick = () => { if (!n.trashed) open(n.id); else noteMenu(n, more); };
      if (!n.trashed) {
        makeDraggable(card, () => {
          // A small copy of the card itself: preview, title and date.
          const g = h('div', 'card-ghost');
          g.append(thumb.cloneNode(true), h('span', 'ghost-title', esc(n.title)), h('span', 'ghost-sub', esc(date)));
          return { ghost: g, thumb: n.thumb };
        }, {
          onStart: () => { if (window.innerWidth <= 760) root.classList.add('side-open'); },
          onDrop: (target) => dropNote(n, target),
        });
      }
      card.onkeydown = (e) => { if (e.key === 'Enter') card.click(); };
      grid.append(card);
    }
  }

  async function dropNote(n: NoteMeta, target: string): Promise<boolean> {
    root.classList.remove('side-open');
    try {
      if (target === 'trash') {
        await db.putNote({ ...n, trashed: Date.now() });
        toast(`Moved “${n.title}” to Recently deleted`);
      } else {
        const folder = target === 'unfiled' ? null : target;
        if (folder === n.folder) { toast(`“${n.title}” is already there`); return false; }
        await db.putNote({ ...n, folder });
        toast(`Moved “${n.title}” to ${folder ? folderOf(folder)?.name ?? 'folder' : 'Unfiled'}`);
      }
    } catch (e) { storageFailed(e); return false; }
    await reload();
    return true;
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
      { label: 'Export note file', icon: icons.share, action: async () => {
        try { await saveBlob(await exportNoteFile(n), `${safeName(n.title)}.inkwell`); } catch (e) { console.error(e); toast('Export failed'); }
      } },
      { label: 'Delete', icon: icons.trash, danger: true, action: async () => {
        await db.putNote({ ...n, trashed: Date.now() });
        toast('Moved to Recently Deleted');
        reload();
      } },
    ], anchor, n.title);
  }

  function moveMenu(n: NoteMeta, anchor: HTMLElement) {
    const dot = (f: Folder) => `<span class="f-dot" style="--f:${colorOf(f)}"></span>`;
    const items = [{ label: 'Unfiled', icon: icons.inbox, checked: !n.folder, action: () => move(null) }];
    for (const { f, depth } of tree()) items.push({ label: `${'    '.repeat(depth)}${f.name}`, icon: dot(f), checked: n.folder === f.id, action: () => move(f.id) });
    async function move(folder: string | null) { await db.putNote({ ...n, folder }); reload(); }
    menu(items, anchor, 'Move to');
  }

  /** Re-parent a folder (not into itself or its own subfolders). */
  function moveFolderMenu(f: Folder, anchor: HTMLElement) {
    const banned = descendants(f.id);
    const dot = (x: Folder) => `<span class="f-dot" style="--f:${colorOf(x)}"></span>`;
    const to = async (parent: string | null) => { await db.putFolder({ ...f, parent }); if (parent) state.collapsed.delete(parent); reload(); };
    const items = [{ label: 'Top level', icon: icons.folder, checked: !f.parent, action: () => to(null) }];
    for (const { f: x, depth } of tree()) {
      if (banned.has(x.id)) continue;
      items.push({ label: `${'    '.repeat(depth)}${x.name}`, icon: dot(x), checked: f.parent === x.id, action: () => to(x.id) });
    }
    menu(items, anchor, `Move “${f.name}” into`);
  }

  async function importFiles(files: File[], folder: string | null) {
    let last: string | null = null;
    for (const file of files) {
      const b = busy(`Importing ${file.name}…`);
      try {
        if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
          const { pages, outline } = await pdfToPages(file, (d, t) => b.set(`Importing ${file.name} — page ${Math.min(d + 1, t)} of ${t}`));
          last = (await createNote(folder, file.name.replace(/\.pdf$/i, ''), pages, outline)).id;
        } else if (/\.inkwell(\.json)?$|\.json$/i.test(file.name)) {
          last = (await importNoteFile(file, folder)).id;
        }
      } catch (e) {
        console.error(e);
        toast(`Could not import ${file.name}`);
      } finally { b.done(); }
    }
    if (last && files.length === 1) open(last);
    else reload();
  }

  function importFlow() {
    pickFiles('.pdf,application/pdf,.inkwell,.json,application/json', { multiple: true })
      .then((files) => { if (files.length) importFiles(files, currentFolder()); });
  }


  root.addEventListener('dragover', (e) => e.preventDefault());
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    importFiles([...(e.dataTransfer?.files ?? [])], currentFolder());
  });

  await reload();
  return () => root.remove();
}
