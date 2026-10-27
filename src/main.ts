import './styles.css';
import { Editor } from './editor/editor';
import { renderLibrary } from './library/library';
import { toast } from './ui/modal';
import { applyAppearance } from './editor/settings';

applyAppearance();

const app = document.getElementById('app')!;
let editor: Editor | null = null;
let closeLibrary: (() => void) | null = null;
let routing = Promise.resolve();

async function route() {
  const m = /^#\/note\/([\w-]+)(?:\/p(\d+))?/.exec(location.hash);
  if (editor) { const e = editor; editor = null; await e.close(); }
  closeLibrary?.();
  closeLibrary = null;
  app.innerHTML = '';
  if (m) {
    try {
      editor = await Editor.open(m[1], app, () => { location.hash = '#/'; }, m[2] ? Number(m[2]) : undefined);
    } catch (e) {
      console.error(e);
      toast('That note could not be opened');
      location.replace('#/');
    }
  } else {
    closeLibrary = await renderLibrary(app, (id) => { location.hash = `#/note/${id}`; });
  }
}

window.addEventListener('hashchange', () => { routing = routing.then(route); });
routing = routing.then(route);

// Never fail silently: surface unexpected errors (helps on iPad, where there's no console).
const report = (err: unknown) => {
  const msg = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  if (msg && msg !== 'undefined') toast(`Something went wrong: ${msg}`, 6000);
};
window.addEventListener('unhandledrejection', (e) => report(e.reason));
window.addEventListener('error', (e) => report(e.error ?? e.message));

// Ask the browser not to evict our notes under storage pressure.
navigator.storage?.persist?.().catch(() => {});

// Block Safari's page-level pinch so only our canvas zooms.
document.addEventListener('gesturestart', (e) => e.preventDefault());

// Offline support only for the standalone app; inside claude.ai the page is framed.
const standalone = window.top === window && !('claude' in window);
if ('serviceWorker' in navigator && import.meta.env.PROD && standalone) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  // When an updated worker takes over (it clears old caches), reload once so
  // the page isn't left running on stale cached responses.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
}
