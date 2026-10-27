// Inkly's daily credits on the hosted (Gemini) app. Google doesn't report how
// much free quota is left, so Inkwell keeps its own daily budget: one credit
// per Inkly answer, reset at midnight Pacific (when Google resets free-tier
// limits). Counted per device. If Google refuses first, its retry time wins.

const KEY = 'inkwell.inklyCredits';
const TZ = 'America/Los_Angeles';

interface Stored { day: string; used: number; blockedUntil?: number }

/** Today's date in Pacific time, e.g. "2026-10-27" (the quota day). */
export function pacificDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Milliseconds until the next midnight in Pacific time. */
export function msUntilPacificMidnight(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsed = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000 + now.getMilliseconds();
  return 86_400_000 - elapsed;
}

/** "5h 12m", "12m", "45s". */
export function formatWait(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

export class Credits {
  constructor(private limit: () => number, private now: () => Date = () => new Date()) {}

  private read(): Stored {
    const today = pacificDay(this.now());
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null;
      if (s && s.day === today) return s;
      // A new quota day; keep a Google block only if it reaches past midnight.
      if (s?.blockedUntil && s.blockedUntil > this.now().getTime()) return { day: today, used: 0, blockedUntil: s.blockedUntil };
    } catch { /* storage blocked */ }
    return { day: today, used: 0 };
  }
  private write(s: Stored) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } }

  get used() { return this.read().used; }
  get left() { return Math.max(0, this.limit() - this.used); }

  /** When asking is next possible, or null if it is possible now. */
  blockedUntil(): number | null {
    const s = this.read();
    const t = this.now().getTime();
    if (s.blockedUntil && s.blockedUntil > t) return s.blockedUntil;
    if (s.used >= this.limit()) return t + msUntilPacificMidnight(this.now());
    return null;
  }

  spend() { const s = this.read(); s.used += 1; this.write(s); }

  /** Google said no: honour its retry time (or the daily reset for daily quotas). */
  blockFor(retryAfterSec: number | undefined, daily: boolean) {
    const s = this.read();
    const t = this.now().getTime();
    s.blockedUntil = daily || !retryAfterSec ? t + msUntilPacificMidnight(this.now()) : t + retryAfterSec * 1000;
    this.write(s);
  }
}
