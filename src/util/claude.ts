// The claude.ai artifact runtime, when Inkwell is opened inside Claude.
type Runtime = { use?: (name: string) => Promise<unknown> };

export const inClaude = typeof window !== 'undefined' && 'claude' in window;

export function useCapability<T>(name: string): Promise<T | null> {
  const c = (window as unknown as { claude?: Runtime }).claude;
  if (!c?.use) return Promise.resolve(null);
  return c.use(name).then((x) => (x as T) ?? null).catch(() => null);
}
