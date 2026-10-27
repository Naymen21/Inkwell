import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Credits, formatWait, msUntilPacificMidnight, pacificDay } from '../src/editor/credits';

let store: Record<string, string> = {};
beforeEach(() => {
  store = {};
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
});
afterEach(() => vi.unstubAllGlobals());

describe('Inkly credits', () => {
  // 2026-10-27 22:30 Pacific (PDT, UTC-7) = 2026-10-28 05:30 UTC.
  const late = new Date('2026-10-28T05:30:00Z');

  it('uses the Pacific calendar day and time to Pacific midnight', () => {
    expect(pacificDay(late)).toBe('2026-10-27');
    expect(msUntilPacificMidnight(late)).toBe(90 * 60 * 1000);
    expect(formatWait(90 * 60 * 1000)).toBe('1h 30m');
    expect(formatWait(42_000)).toBe('42s');
  });

  it('counts down and blocks until Pacific midnight when used up', () => {
    let now = late;
    const c = new Credits(() => 2, () => now);
    expect(c.left).toBe(2);
    c.spend(); c.spend();
    expect(c.left).toBe(0);
    expect(c.blockedUntil()).toBe(late.getTime() + 90 * 60 * 1000);
    // After midnight Pacific a new day starts with a full budget.
    now = new Date(late.getTime() + 91 * 60 * 1000);
    expect(c.left).toBe(2);
    expect(c.blockedUntil()).toBeNull();
  });

  it("honours Google's retry time for short limits", () => {
    const c = new Credits(() => 50, () => late);
    c.blockFor(37, false);
    expect(c.blockedUntil()).toBe(late.getTime() + 37_000);
    expect(c.left).toBe(50);
  });
});
