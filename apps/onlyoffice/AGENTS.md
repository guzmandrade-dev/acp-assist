# AGENTS.md — ONLYOFFICE app (apps/onlyoffice)

Decisions, verified facts, and pitfalls for the ONLYOFFICE ACP Assist app.
Seeded 2026-11-01 from the Phase 0 probe session (user-approved). Product
build is NOT yet approved; `next-steps.md` (repo root) holds the plan and
current status. Everything below was live-verified against **ONLYOFFICE
Desktop Editors 10.0.0.169** (Qt5 + CEF/Chromium 109, Windows) using the
probe plugin (`spike/probe-plugin`, guid
`asc.{B4F7A1C2-3D4E-4F5A-9B6C-7D8E9F0A1B2C}` — still installed in the
user's editors) and the probe companion (`spike/probe-server/server.mjs`,
port 8791; log beside it).

## Environment facts

- Install dir: `C:\Program Files\ONLYOFFICE\DesktopEditors`
  (CEF shell `DesktopEditors.exe`; `editors\web-apps\` = the editor UI).
- User-installed plugins are extracted to
  `%LOCALAPPDATA%\ONLYOFFICE\DesktopEditors\data\sdkjs-plugins\{GUID}\`
  and load as iframes from a **file://** URL.
- The editor host page itself also runs from `file://`
  (`parentOrigin=file://`).
- `data\sdkjs-plugins\addons` is a small hash/registry FILE, not a folder:
  installed addons are pinned there by signature hashes → **manual
  sideloading by copying folders does not work; installs must go through
  the Plugin Manager .plugin upload.**

## Verified rules (numbered, LO-app convention)

1. **Transport works (the #1 unknown, resolved).** A plugin iframe
   (file:// origin) CAN `fetch()` a localhost companion over plain HTTP
   as long as the companion sends `Access-Control-Allow-Origin: *`.
   No mixed-content enforcement, no CORS pain. Measured ping RTT ~11ms.
   The companion owns the port — no discovery mechanism needed.
2. **Push channel: long-poll.** Plugin long-polls `GET /probe?wait=20`;
   companion queues commands via `POST /cmd`. Delivery latency ~5ms
   after queueing; full queue→execute→result-report round-trip ~60ms.
   This is the companion→plugin half of the bridge.
3. **`callCommand` callback: use the 4-arg form** —
   `callCommand(fn, false, false, cb)` — `cb` receives the value
   returned by `fn`. Worked on first call in 10.0. (3-arg form untested;
   probe had a timeout-based fallback that never fired.)
4. **One `callCommand` = one undo step.** After an insert via
   callCommand, the quick-access Undo button went disabled→enabled, and
   a single Ctrl+Z reverted the whole insert (verified by re-reading
   the document: 2 paragraphs → 1). The single-undo-edit principle from
   the LO app carries over.
5. **`attachEvent("onSelectionChange"|"onChangeContent"|"onCursorMove")`
   is a trap**: it accepts the names without throwing, but the events
   never fire — neither on callCommand edits nor on real user typing.
   Negative result, live-verified twice. Do not build on these.
6. **Live selection updates must come from polling** (or from config
   `events`, untested). A 2s poll of
   `executeMethod("GetSelectionType")` + `executeMethod("GetSelectedText")`
   works: both methods return values via callback, and change-detection
   + reporting to the companion was verified (baseline snapshot
   reported). GetSelectedText returns "" until an actual selection
   exists.
7. **Document reads:** inside callCommand,
   `Api.GetDocument().GetElementsCount()` +
   `GetElement(i).GetText()` yields indexed paragraphs — the [pN]
   addressing scheme of the LO app maps directly. Quirk: `GetText()`
   returns `\r\r\n` line endings on 10.0 — normalize when diffing.
8. **Insert at cursor:** `Api.CreateParagraph()` + `AddText()` +
   `oDocument.InsertContent([oParagraph])` inside one callCommand.
9. **Visual plugins mount a left sidebar** (`isVisual: true`,
   `isInsideMode: true` in config.json) — the chat-panel shape works
   out of the box; the plugin's iframe content (buttons, log) is
   exposed to Windows accessibility, so the editor UI is scriptable.
10. **Distribution needs no approval:** zip the plugin folder, rename
    the extension to `.plugin`, Plugin Manager → "Install plugin
    manually" → file dialog (already filtered to `*.plugin`) → the
    plugin is installed instantly, appears in the Plugins tab, no
    restart, no signing, no marketplace. (Marketplace listing is a
    separate, curated PR process — see root next-steps.md.)
11. **Automation gotcha:** the Plugin Manager dialog overlay covers the
    toolbar — close it before clicking toolbar buttons, or clicks land
    on the overlay.
12. **CEF/Qt automation gotcha (computer-use):** clicks into the web
    area do NOT register while the window is occluded/backgrounded;
    they work when the window is foreground. Drive the app only while
    it is visible/foreground.

## Bridge v0 (Phase 1) — verified 2026-11-01 night

Product code: `bridge-plugin/` (guid
`asc.{7E2F9A41-6B3C-4D58-9E7A-1F4B8C6D2E39}`, installed in the user's
editors as "ACP Assist Bridge"); test companion
`spike/bridge-server/server.mjs` (port 8792, stop after sessions —
restart with `node server.mjs`). Live-tested end-to-end in Writer:

13. **The bridge protocol works over the long-poll channel.** Wire
    surface: `POST /bridge/hello` (plugin announces editor type), `GET
    /bridge/next` (long-poll job `{id, op, args}`), `POST
    /bridge/result` (`{id, ok, data|error}`), `POST /bridge/event`
    (selection-change from the 2s poll). Drive→result round-trip is
    ~50–150ms per op.
14. **All Writer ops verified**: `insert` (InsertContent at cursor),
    `insertAfter {index}` (via `ApiDocument.AddElement(nPos, oElement)`
    — inherited from ApiDocumentContent), `rewriteAt {index}`
    (`RemoveElement(nPos)` + `AddElement(nPos, new)` inside ONE
    callCommand), `deleteAt {index}` (`RemoveElement(nPos)`),
    `rewriteSelection` (`executeMethod("PasteHtml", [html])` — the
    editor's own paste route; verified via Ctrl+A + replace).
    `context` returns paragraphs + selection + editor; `journal` keeps
    old text per op for a future panel Undo button.
15. **Single-undo-per-op verified for every op**: 4 ops → exactly 4
    Ctrl+Z restored the document byte-identical (read back via
    context); the compound rewriteAt counts as ONE step; PasteHtml
    selection rewrite is one step and restores the selection too.
16. **Editor detection inside callCommand**: `Api.GetSheets()` → cell,
    `Api.GetCurrentSlide()` → slide, else word (typeof-guarded). v0
    implements word ops only; cell/slide ops return a clean
    "not implemented for editor" error.
17. `GetText()` quirks confirmed again: paragraphs read with `\r\r\n`/
    `\r\n` endings — the bridge normalizes them before returning to
    the companion.

## Probe artifacts (spike/)

- `probe-plugin/` — the probe plugin sources (config.json, index.html,
  scripts/code.js: P1–P4 instrumentation, long-poll client, report()).
- `acp-probe.plugin` — packaged artifact (Compress-Archive + rename).
  Repackage after editing probe sources.
- `probe-server/server.mjs` — zero-dep Node companion (CORS-open,
  long-poll command channel, /report logging). Start with
  `node server.mjs`; logs to `probe-server.log`.
- The probe plugin remains installed in the user's Desktop Editors
  (Plugins tab → "ACP Assist Probe") for future sessions. Remove via
  Plugin Manager if needed.