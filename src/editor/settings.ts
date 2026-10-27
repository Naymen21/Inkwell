import type { FontKind, Template } from '../model/types';

export type ToolName = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'shape' | 'text';

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
  paper: { template: Template; color: string; size: 'letter' | 'a4' };
}

export const PEN_COLORS = ['#1c1c1e', '#2f6bd8', '#d63a3a', '#2e9a5b', '#8a4fd1', '#e8862a'];
export const HL_COLORS = ['#ffe14d', '#7ef08a', '#7fd3ff', '#ff9ad5', '#ffb26b'];
export const PAPER_COLORS = ['#ffffff', '#fbf6e8', '#eef3f8', '#24262b'];

const defaults: Settings = {
  tool: 'pen',
  pen: { color: PEN_COLORS[0], width: 2.2, pressure: true },
  penWidths: [1.4, 2.2, 3.6],
  highlighter: { color: HL_COLORS[0], width: 14 },
  hlWidths: [8, 14, 22],
  eraser: { mode: 'partial', size: 14, highlighterOnly: false },
  text: { size: 16, color: PEN_COLORS[0], bold: false, font: 'sans' },
  recentColors: [],
  fingerDraw: true,
  holdToSnap: true,
  paper: { template: 'lined', color: '#ffffff', size: 'letter' },
};

function load(): Settings {
  try {
    const raw = localStorage.getItem('inkwell.settings');
    if (raw) {
      const s = JSON.parse(raw);
      return { ...defaults, ...s, pen: { ...defaults.pen, ...s.pen }, highlighter: { ...defaults.highlighter, ...s.highlighter },
        eraser: { ...defaults.eraser, ...s.eraser }, text: { ...defaults.text, ...s.text }, paper: { ...defaults.paper, ...s.paper } };
    }
  } catch { /* storage blocked */ }
  return structuredClone(defaults);
}

export const settings: Settings = load();

export function saveSettings() {
  try { localStorage.setItem('inkwell.settings', JSON.stringify(settings)); } catch { /* ignore */ }
}
