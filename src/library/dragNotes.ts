// Drag a note card onto a sidebar destination (folder, Unfiled, Recently
// deleted). Mouse/pen start after a short move; touch starts after a
// press-and-hold so normal swiping still scrolls the grid. Once a touch drag
// has started it is tracked with touch events on the window: iPad Safari may
// fire pointercancel as soon as the finger moves (it thinks a scroll began),
// which must not end the drag.

const HOLD_MS = 380;
const SLOP = 8;

export interface DragHooks {
  /** Called once the drag has really started (e.g. to reveal a hidden sidebar). */
  onStart(): void;
  /** Called with the drop target id; resolve true if the note moved. */
  onDrop(target: string): Promise<boolean>;
}

export interface DragPreview {
  /** Floating copy of the note that follows the finger. */
  ghost: HTMLElement;
  /** Thumbnail image URL for the mini copy shown inside the hovered folder. */
  thumb?: string;
}

export function makeDraggable(card: HTMLElement, preview: () => DragPreview, hooks: DragHooks) {
  let pid = -1;
  let sx = 0, sy = 0, lx = 0, ly = 0;
  let timer = 0;
  let touchDrag = false;
  let ghost: HTMLElement | null = null;
  let thumb: string | undefined;
  let over: HTMLElement | null = null;
  let suppressClick = false;

  const targetAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-drop]') ?? null;

  const mini = () => {
    const m = document.createElement('span');
    m.className = 'drop-mini';
    if (thumb) { const img = document.createElement('img'); img.src = thumb; img.alt = ''; m.append(img); }
    return m;
  };

  const setOver = (t: HTMLElement | null) => {
    if (t === over) return;
    if (over) { over.classList.remove('drop-hover'); over.querySelector('.drop-mini')?.remove(); }
    over = t;
    if (over) { over.classList.add('drop-hover'); over.append(mini()); }
    ghost?.classList.toggle('over-target', !!over);
  };

  const place = (x: number, y: number) => {
    lx = x; ly = y;
    if (!ghost) return;
    // Sit up and to the right of the finger so the folder name under it stays readable.
    ghost.style.transform = `translate(${x + 14}px, ${y - 150}px) rotate(-4deg) scale(${over ? 0.72 : 1})`;
    setOver(targetAt(x, y));
  };

  const begin = (x: number, y: number) => {
    clearTimeout(timer);
    const p = preview();
    ghost = p.ghost;
    thumb = p.thumb;
    ghost.classList.add('drag-ghost');
    document.body.append(ghost);
    card.classList.add('drag-source');
    document.body.classList.add('dragging-note');
    navigator.vibrate?.(10);
    hooks.onStart();
    place(x, y);
  };

  const cleanup = () => {
    clearTimeout(timer);
    window.removeEventListener('pointermove', pmove);
    window.removeEventListener('pointerup', pup);
    window.removeEventListener('pointercancel', pcancel);
    window.removeEventListener('touchmove', tmove);
    window.removeEventListener('touchend', tend);
    window.removeEventListener('touchcancel', tcancel);
    pid = -1;
    touchDrag = false;
  };

  const finish = async (drop: boolean) => {
    cleanup();
    if (!ghost) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 80);
    const g = ghost, target = over;
    ghost = null;
    card.classList.remove('drag-source');
    document.body.classList.remove('dragging-note');
    const id = target?.dataset.drop;
    if (drop && target && id) {
      // Fly the note into the folder, then pulse the folder.
      const r = target.getBoundingClientRect();
      g.classList.add('landing');
      g.style.transform = `translate(${r.right - 60}px, ${r.top + r.height / 2 - 40}px) scale(0.15)`;
      g.style.opacity = '0';
      const moved = await hooks.onDrop(id).catch(() => false);
      target.classList.remove('drop-hover');
      target.querySelector('.drop-mini')?.remove();
      // The sidebar re-renders after a move, so pulse the fresh row.
      const row = moved ? document.querySelector<HTMLElement>(`[data-drop="${CSS.escape(id)}"]`) : null;
      if (row) { row.classList.add('drop-done'); setTimeout(() => row.classList.remove('drop-done'), 600); }
      setTimeout(() => g.remove(), 260);
    } else {
      setOver(null);
      g.remove();
    }
    over = null;
  };

  // Pointer path (mouse, pen, and touch until the hold completes).
  const pmove = (e: PointerEvent) => {
    if (e.pointerId !== pid || touchDrag) return;
    if (ghost) { place(e.clientX, e.clientY); return; }
    if (Math.hypot(e.clientX - sx, e.clientY - sy) <= SLOP) return;
    // A touch that moves before the hold finishes is a scroll, not a drag.
    if (e.pointerType === 'touch') { cleanup(); return; }
    begin(e.clientX, e.clientY);
  };
  const pup = (e: PointerEvent) => { if (e.pointerId === pid && !touchDrag) finish(true); };
  const pcancel = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    if (touchDrag) return; // iPad cancels pointers mid-drag; touch events carry on.
    finish(false);
  };

  // Touch path, once a press-and-hold has started a drag.
  const tmove = (e: TouchEvent) => {
    if (!ghost) return;
    e.preventDefault();
    const t = e.touches[0];
    if (t) place(t.clientX, t.clientY);
  };
  const tend = (e: TouchEvent) => {
    if (!ghost) { cleanup(); return; }
    e.preventDefault();
    const t = e.changedTouches[0];
    if (t) place(t.clientX, t.clientY);
    finish(true);
  };
  const tcancel = () => finish(false);

  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || pid !== -1 || (e.target as HTMLElement).closest('button')) return;
    pid = e.pointerId;
    sx = lx = e.clientX;
    sy = ly = e.clientY;
    window.addEventListener('pointermove', pmove);
    window.addEventListener('pointerup', pup);
    window.addEventListener('pointercancel', pcancel);
    if (e.pointerType === 'touch') {
      timer = window.setTimeout(() => {
        touchDrag = true;
        window.addEventListener('touchmove', tmove, { passive: false });
        window.addEventListener('touchend', tend, { passive: false });
        window.addEventListener('touchcancel', tcancel);
        begin(lx, ly);
      }, HOLD_MS);
    }
  });
  // Keep the page from scrolling under a finger that is dragging.
  card.addEventListener('touchmove', (e) => { if (ghost) e.preventDefault(); }, { passive: false });
  // The click that ends a drag must not also open the note.
  card.addEventListener('click', (e) => { if (suppressClick) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  card.addEventListener('contextmenu', (e) => e.preventDefault());
}
