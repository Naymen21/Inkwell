// Drag a note card onto a sidebar destination (folder, Unfiled, Recently
// deleted). Pointer-based so it works the same with a mouse, trackpad,
// Apple Pencil or finger: mouse/pen start after a short move; touch starts
// after a press-and-hold so normal swiping still scrolls the grid.

const HOLD_MS = 380;
const SLOP = 8;

export interface DragHooks {
  /** Called once the drag has really started (e.g. to reveal a hidden sidebar). */
  onStart(): void;
  /** Drop target id under the pointer was released on. */
  onDrop(target: string): void;
}

export function makeDraggable(card: HTMLElement, preview: () => HTMLElement, hooks: DragHooks) {
  let pid = -1;
  let sx = 0, sy = 0;
  let timer = 0;
  let ghost: HTMLElement | null = null;
  let over: HTMLElement | null = null;
  let suppressClick = false;

  const targetAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-drop]') ?? null;

  const begin = (x: number, y: number) => {
    clearTimeout(timer);
    ghost = preview();
    ghost.classList.add('drag-ghost');
    document.body.append(ghost);
    card.classList.add('drag-source');
    document.body.classList.add('dragging-note');
    navigator.vibrate?.(10);
    hooks.onStart();
    place(x, y);
  };

  const place = (x: number, y: number) => {
    if (!ghost) return;
    ghost.style.transform = `translate(${x - 40}px, ${y - 50}px) rotate(-3deg)`;
    const t = targetAt(x, y);
    if (t !== over) {
      over?.classList.remove('drop-hover');
      over = t;
      over?.classList.add('drop-hover');
    }
  };

  const end = (drop: boolean) => {
    clearTimeout(timer);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    if (ghost) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 50);
      const target = over?.dataset.drop;
      over?.classList.remove('drop-hover');
      ghost.remove();
      card.classList.remove('drag-source');
      document.body.classList.remove('dragging-note');
      if (drop && target) hooks.onDrop(target);
    }
    ghost = null;
    over = null;
    pid = -1;
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    if (ghost) { place(e.clientX, e.clientY); return; }
    const far = Math.hypot(e.clientX - sx, e.clientY - sy) > SLOP;
    if (!far) return;
    // A touch that moves before the hold finishes is a scroll, not a drag.
    if (e.pointerType === 'touch') end(false);
    else begin(e.clientX, e.clientY);
  };
  const up = (e: PointerEvent) => { if (e.pointerId === pid) end(true); };
  const cancel = (e: PointerEvent) => { if (e.pointerId === pid) end(false); };

  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || pid !== -1 || (e.target as HTMLElement).closest('button')) return;
    pid = e.pointerId;
    sx = e.clientX;
    sy = e.clientY;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    if (e.pointerType === 'touch') timer = window.setTimeout(() => begin(sx, sy), HOLD_MS);
  });
  // Once dragging, stop the page from scrolling under the finger.
  card.addEventListener('touchmove', (e) => { if (ghost) e.preventDefault(); }, { passive: false });
  // The click that ends a drag must not also open the note.
  card.addEventListener('click', (e) => { if (suppressClick) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  card.addEventListener('contextmenu', (e) => e.preventDefault());
}
