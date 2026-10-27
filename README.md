# Inkwell

Notability-style handwritten notes for the web, built to be used on iPad with Apple Pencil
(installable to the Home Screen) and on desktop with a mouse or trackpad.

Built from `notability-clone-spec.md`. The Apple-native pieces map to web equivalents:

| Spec (Apple)                 | Here (web)                                                   |
|------------------------------|--------------------------------------------------------------|
| Metal tiles + dirty rects    | Per-page canvas viewport tiles, dirty-rect redraw            |
| UITouch coalesced/predicted  | `getCoalescedEvents()` / `getPredictedEvents()`              |
| `.note` package + oplog.bin  | IndexedDB: append-only op log + periodic snapshots           |
| AVAudioRecorder              | MediaRecorder, flushed to IndexedDB every 4 s                |
| TextKit text boxes           | DOM text boxes (native editing, Scribble works on iPad)      |
| PDFKit import/export         | pdf.js import, jsPDF export                                  |
| CloudKit sync                | Not built — `.inkwell` file export/import moves notes between devices. Ops already carry Lamport clocks + device IDs, and `NoteDocument.merge` is ready for a sync backend. |
| Handwriting recognition      | Not built (search covers titles + typed text)                |

## Run

```
npm install
npm run dev      # http://localhost:5173 (also exposed on your LAN)
npm test         # model + ink math unit tests
npm run build    # static site in dist/
```

Microphone recording and Home Screen install need HTTPS, so on an iPad use a deployed
copy (any static host, e.g. Vercel) rather than the LAN dev server.

## Using it

- **Pencil vs finger:** until a pencil is seen, one finger draws. Once an Apple Pencil
  touches the screen, fingers scroll/pinch and palms are ignored (toggle in ⋯ → Draw with finger).
- **Shapes:** hold the pen still at the end of a stroke to snap it, or use the Shapes tool.
- **Audio:** tap the mic while writing. Afterwards press play — ink written later is faded,
  and tapping any writing jumps the audio to the moment you wrote it.
- **Keys:** P/H/E/L/S/T tools, ⌘Z / ⇧⌘Z, ⌘C/⌘X/⌘D/⌫ on a selection, ⌘0 fit width, space-drag to pan.

## Layout

```
src/model     pure document model: ops, Lamport log, materialize, undo (no DOM)
src/ink       smoothing, fitting, outline building, erase splitting, shape recognition
src/persist   IndexedDB store
src/render    paper, object drawing, page tiles, media cache
src/editor    editor, input pipeline, tools, text layer, audio, import/export, toolbar
src/library   dividers → subjects → notes
```
