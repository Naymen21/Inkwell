// Pure document model types. Nothing in src/model imports DOM or rendering code.
import type { Rect } from '../util/geom';

export type InkTool = 'pen' | 'highlighter';
export type Template = 'blank' | 'lined' | 'grid' | 'dotted';
export type FontKind = 'sans' | 'serif' | 'mono' | 'hand';

interface BaseObj {
  id: string;
  /** Owning page id (objects reference pages by id so page inserts never renumber them). */
  page: string;
  /** Seconds on the note's recording timeline when this object was created (see audio). */
  createdAt: number;
}

export interface StrokeObj extends BaseObj {
  kind: 'stroke';
  tool: InkTool;
  color: string;
  opacity: number;
  /** Fitted control points, flat [x, y, width, x, y, width, ...] in page points. */
  pts: number[];
  bbox: Rect;
}

export interface TextObj extends BaseObj {
  kind: 'text';
  x: number; y: number; w: number; h: number;
  text: string;
  size: number;
  color: string;
  bold: boolean;
  font: FontKind;
}

export interface ImageObj extends BaseObj {
  kind: 'image';
  x: number; y: number; w: number; h: number;
  /** Content hash of the blob in the media store. */
  media: string;
}

export type PageObject = StrokeObj | TextObj | ImageObj;

export interface Page {
  id: string;
  w: number;
  h: number;
  template: Template;
  paper: string;
  /** Media hash of a background image (imported PDF page or image). */
  bg?: string;
}

export type Op =
  | { t: 'add'; obj: PageObject; index?: number }
  | { t: 'remove'; id: string }
  | { t: 'update'; id: string; patch: Partial<PageObject> }
  | { t: 'addPage'; page: Page; after: string | null }
  | { t: 'removePage'; id: string }
  | { t: 'updatePage'; id: string; patch: Partial<Page> };

export interface LoggedOp {
  id: string;
  op: Op;
  /** Timeline seconds when the op was committed. */
  ts: number;
  /** Lamport clock; total order is (lamport, device). */
  lamport: number;
  device: string;
}

export interface Snapshot {
  pages: Page[];
  /** Objects grouped per page in z-order. */
  objects: Record<string, PageObject[]>;
}

export interface Clip {
  id: string;
  /** Start position on the note timeline (seconds). */
  start: number;
  duration: number;
  mime: string;
}

export interface NoteMeta {
  id: string;
  title: string;
  folder: string | null;
  created: number;
  modified: number;
  trashed?: number;
  thumb?: string;
  searchText?: string;
  clips: Clip[];
  pageCount?: number;
}

export interface Folder {
  id: string;
  name: string;
  /** null = divider (top level); otherwise the divider id this subject sits under. */
  parent: string | null;
  created: number;
}

export const PAGE_SIZES = {
  letter: { w: 612, h: 792 },
  a4: { w: 595, h: 842 },
} as const;
