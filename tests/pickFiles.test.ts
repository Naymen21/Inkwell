import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickFiles } from '../src/ui/pickFiles';

// Minimal DOM stand-in: enough to observe that the input is attached when clicked.
function fakeDom() {
  const body = { children: [] as unknown[], append(el: unknown) { this.children.push(el); } };
  const make = () => {
    const listeners: Record<string, () => void> = {};
    const el = {
      type: '', accept: '', multiple: false, style: {}, files: null as unknown,
      attachedAtClick: false,
      setAttribute() {},
      addEventListener(t: string, fn: () => void) { listeners[t] = fn; },
      remove() { body.children = body.children.filter((c) => c !== el); },
      click() { el.attachedAtClick = body.children.includes(el); },
      fire(t: string) { listeners[t]?.(); },
    };
    return el;
  };
  vi.stubGlobal('document', { body, createElement: make });
  return body;
}

afterEach(() => vi.unstubAllGlobals());

describe('pickFiles', () => {
  it('attaches the input before clicking and removes it after a choice', async () => {
    const body = fakeDom();
    const p = pickFiles('image/*');
    const input = body.children[0] as { attachedAtClick: boolean; files: unknown; fire(t: string): void };
    expect(input.attachedAtClick).toBe(true);
    input.files = [{ name: 'a.png' }];
    input.fire('change');
    expect(await p).toEqual([{ name: 'a.png' }]);
    expect(body.children).toHaveLength(0);
  });

  it('resolves empty when the picker is cancelled', async () => {
    const body = fakeDom();
    const p = pickFiles('.pdf');
    (body.children[0] as { fire(t: string): void }).fire('cancel');
    expect(await p).toEqual([]);
  });
});
