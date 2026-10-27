import type { FontKind, Template } from '../model/types';

export type ToolName = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'shape' | 'text';
/** Everything that can sit in the tool dock. */
export type DockItem = ToolName | 'insert' | 'mic' | 'hand';
export interface DockSlot { id: DockItem; hidden: boolean }
export interface Favorite { color: string; width: number }
export type Appearance = 'system' | 'light' | 'dark';

export const DEFAULT_DOCK: DockItem[] = ['pen', 'shape', 'highlighter', 'eraser', 'text', 'lasso', 'insert', 'mic', 'hand'];

export interface Settings {
  tool: ToolName;
  pen: { color: string; width: number; pressure: boolean };
  penWidths: number[];
  highlighter: { color: string; width: number };
  hlWidths: number[];
  eraser: { mode: 'stroke' | 'partial'; size: number; highlighterOnly: boolean };
  text: { size: number; color: string; bold: boolean; font: FontKind };
  recentColors: string[];
  fingerDraw: boolean;
  holdToSnap: boolean;
  straightLines: boolean;
  autoDeselectEraser: boolean;
  lassoMode: 'free' | 'rect';
  dock: DockSlot[];
  appearance: Appearance;
  /** Inkly answers per day on the hosted (Gemini) app. */
  inklyDailyCredits: number;
  /** One-tap presets: five for the pen, five for the highlighter. */
  penFavorites: Favorite[];
  hlFavorites: Favorite[];
  paper: { template: Template; color: string; size: 'letter' | 'a4' };
}

export const PEN_COLORS = ['#1c1c1e', '#e5484d', '#8e8e93', '#ffffff', '#7a4b2a', '#30a46c', '#3e7bfa', '#8e4ec6'];
export const HL_COLORS = ['#ffe14d', '#7ef08a', '#7fd3ff', '#ff9ad5', '#ffb26b'];
export const PAPER_COLORS = ['#ffffff', '#fbf7ee', '#f1f4f8', '#262321'];

const defaults: Settings = {
  tool: 'pen',
  pen: { color: PEN_COLORS[0], width: 2.2, pressure: true },
  penWidths: [1.4, 2.2, 3.6],
  highlighter: { color: HL_COLORS[0], width: 14 },
  hlWidths: [8, 14, 22],
  eraser: { mode: 'partial', size: 18, highlighterOnly: false },
  text: { size: 16, color: PEN_COLORS[0], bold: false, font: 'sans' },
  recentColors: [],
  fingerDraw: true,
  holdToSnap: true,
  straightLines: true,
  autoDeselectEraser: false,
  lassoMode: 'free',
  dock: DEFAULT_DOCK.map((id) => ({ id, hidden: false })),
  appearance: 'system',
  // Free Gemini allows ~1,000+ requests/day per model (per project, Oct 2026).
  // 250 per device keeps 2 people x 2 devices within one model's daily limit.
  inklyDailyCredits: 250,
  penFavorites: [
    { color: '#1c1c1e', width: 2.2 },
    { color: '#3e7bfa', width: 2.2 },
    { color: '#e5484d', width: 2.2 },
    { color: '#30a46c', width: 2.2 },
    { color: '#1c1c1e', width: 3.6 },
  ],
  hlFavorites: [
    { color: '#ffe14d', width: 14 },
    { color: '#7ef08a', width: 14 },
    { color: '#7fd3ff', width: 14 },
    { color: '#ff9ad5', width: 14 },
    { color: '#ffb26b', width: 22 },
  ],
  paper: { template: 'grid', color: '#ffffff', size: 'letter' },
};

function load(): Settings {
  try {
    const raw = localStorage.getItem('inkwell.settings');
    if (raw) {
      const s = JSON.parse(raw);
      return { ...defaults, ...s, pen: { ...defaults.pen, ...s.pen }, highlighter: { ...defaults.highlighter, ...s.highlighter },
        eraser: { ...defaults.eraser, ...s.eraser }, text: { ...defaults.text, ...s.text }, paper: { ...defaults.paper, ...s.paper },
        dock: normalizeDock(s.dock),
        ...splitFavorites(s),
        // 50 was the original default; move people who never changed it to the new one.
        inklyDailyCredits: !s.inklyDailyCredits || s.inklyDailyCredits === 50 ? defaults.inklyDailyCredits : s.inklyDailyCredits };
    }
  } catch { /* storage blocked */ }
  return structuredClone(defaults);
}

/** Older saves kept one mixed favorites list; split it into pen and highlighter sets. */
function splitFavorites(s: { favorites?: { tool?: string; color: string; width: number }[]; penFavorites?: Favorite[]; hlFavorites?: Favorite[] }) {
  const fill = (list: Favorite[], defs: Favorite[]) => [...list, ...defs.slice(list.length)].slice(0, 5);
  if (s.penFavorites && s.hlFavorites) return { penFavorites: fill(s.penFavorites, defaults.penFavorites), hlFavorites: fill(s.hlFavorites, defaults.hlFavorites) };
  const old = Array.isArray(s.favorites) ? s.favorites : [];
  const pick = (tool: string) => old.filter((f) => f.tool === tool).map(({ color, width }) => ({ color, width }));
  return { penFavorites: fill(pick('pen'), defaults.penFavorites), hlFavorites: fill(pick('highlighter'), defaults.hlFavorites) };
}

/** Keep a saved dock valid: known items only, no duplicates, new items appended. */
export function normalizeDock(saved: unknown): DockSlot[] {
  const out: DockSlot[] = [];
  if (Array.isArray(saved)) {
    for (const s of saved) {
      if (s && DEFAULT_DOCK.includes(s.id) && !out.some((o) => o.id === s.id)) out.push({ id: s.id, hidden: !!s.hidden });
    }
  }
  for (const id of DEFAULT_DOCK) if (!out.some((o) => o.id === id)) out.push({ id, hidden: false });
  return out;
}

export const settings: Settings = load();

/** Apply the Light / Dark / System choice to the page. */
let themed = false;
export function applyAppearance() {
  const root = document.documentElement;
  // Only clear a theme we set: inside Claude the viewer sets its own.
  if (settings.appearance === 'system') { if (themed) delete root.dataset.theme; themed = false; }
  else { root.dataset.theme = settings.appearance; themed = true; }
}

export function saveSettings() {
  try { localStorage.setItem('inkwell.settings', JSON.stringify(settings)); } catch { /* ignore */ }
}
