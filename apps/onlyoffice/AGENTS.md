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

## Phase 2 companion (2026-11-01 night) — verified live end-to-end

Product code: `apps/onlyoffice` (npm workspace `onlyoffice-acp-assist`);
companion = core `createCompanionServer` + the OO `CompanionBackend`
(`src/server.ts`) + `src/bridge/plugin-bridge.ts` (the plugin-facing
endpoints). Bridge plugin v0.2 installed in the user's editors
(styles, port field, camelCase ops). **FULL E2E VERIFIED LIVE with
vibe-acp**: panel message → context read → agent reply with
`[ACTION: insert-top]` → heading+paragraph landed in the document
(agent re-read confirmed [p1] "Bridge Test Results", [p2] the body);
a second `[ACTION: none]` round-trip listed the document correctly.
18/18 vitest with a fake plugin bridge; LyX + LO suites still green.

18. **The core auth guard blocks non-/api routes too** — the plugin's
    long-poll endpoints sat behind the bearer token + the OPTIONS
    preflight (which never carries credentials) 401'd. Fix: core
    `CompanionServerOptions.preAuthRoutes` registers routes BEFORE the
    guard; the OO app registers `/bridge/*` there (v1 trade-off: the
    plugin is a file:// iframe with no secret delivery channel, so the
    bridge routes are unauthenticated; server binds 127.0.0.1 only;
    follow-up = deliver the token to the plugin via the served
    /panel-boot.js and re-enable auth).
19. **`executeCommand("command", "window.Asc.editor.asc_Undo();")` is
    a silent no-op**: it does not throw (the plugin's undo op reports
    `undone:true`) but the document is NOT reverted (verified live:
    panel Undo button said "Undo sent to ONLYOFFICE", paragraphs
    remained). v1's honest behavior should be `{undone:false}` so the
    companion shows the Ctrl+Z hint. NOT yet fixed — the plugin needs
    a v0.2.1 bump + reinstall. Ctrl+Z always works (one step per edit).
20. **Companion port is fixed 8790** (the plugin has a port field,
    default 8790, persisted in localStorage): Electron gets a pinned
    default via the new panel-package `listenPort` option (PORT env
    still overrides); dev runs use `PORT=8790 node dist/standalone.js`.
21. Editor restarts do NOT lose the connection: the v0.2 plugin
    re-hellos on its 3s retry loop and the companion's
    `isConnected()` (hello + fresh long-poll within 30s) flips true
    again. Killing a dev companion leaves stale keep-alive sockets —
    always find the LISTENING PID (`netstat -ano`) and kill by PID.
22. Panel shared strings were LO-hardcoded (doc-select title, composer
    hint, undo title, boot status text) — now parameterized
    (`CONFIG.appName`); the OO panel reads "ONLYOFFICE connected".

## Phase 3 module adapters — LIVE-VERIFIED 2026-11-02 (plugin v0.3.5)

All three editors are wired end to end and every new op was verified
live against Desktop Editors (spreadsheet + presentation open, bridge
plugin v0.3.5 installed, driven through `spike/bridge-server/server.mjs`
— now PORT-configurable; `drive.mjs` beside it drives single ops).
Companion gates: OO 28/28 vitest, LyX 147/147, LO 78/78, core 20/20,
panel 6/6, typechecks clean. The install/reinstall loop (5 rounds
v0.3.0→v0.3.5) surfaced these rules — all live-verified:

25. **ApiRange.GetRow()/GetCol() are 1-BASED** (rule 23a resolved):
   a used range of A1:B2 reports row 1 / col 1. GetRangeByNumber(r,c)
   is 0-based (writeCells A1 wrote exactly A1). GetRowsCount/
   GetColumnsCount are counts. The plugin now normalizes with
   GetRow()-1 / GetCol()-1; the data block read matches GetAddress().
26. **GetEntireRow().Insert('down') / GetEntireColumn().Insert('right')
   insert whole rows/columns** (rule 23b resolved): verified by
   reading back shifted values; the editor auto-adjusts formulas after
   inserts (=A2*2 became =A3*2 after a row insert). writeCells,
   insertRows, insertCols all verified end to end. The `undo` op
   returns {undone:false} and the companion shows the Ctrl+Z hint.
27. **Slide detection needs Api.GetPresentation()** — rule 16
   CORRECTED: `Api.GetCurrentSlide` is an ApiPresentation method, not
   global Api, so presentations fell through to "word" (a live v0.3.2
   bug). detectEditor now: GetSheets → cell, GetPresentation → slide,
   else word.
28. **ApiDocumentContent.AddElement takes (pos, element)** — a one-arg
   AddElement(el) call is a SILENT NO-OP (titles read back empty). The
   one-arg append is Push(el). setShapeParas pushes with an
   AddElement(count, el) fallback.
29. **An UNBOUNDED loop inside callCommand freezes the whole editor**
   (document thread + plugin iframe; only a process restart clears
   it). v0.3.2's `while (GetElementsCount() > 0) RemoveElement(0)`
   did this live. Every loop inside callCommand sources must be
   bounded (v0.3.3+); `cmd()` also rejects after a 30s timeout so a
   stuck callCommand can never wedge the long-poll loop permanently.
30. **Placeholder contents re-grow empty paragraphs around writes**:
   after RemoveAllElements + Push, titles read back as "\n\n<text>"
   (two leading empty paragraphs; also invisible empty body lines).
   setShapeParas trims leading empty paragraphs after writing (bounded
   loop; stops at the first non-empty or at lines.length).
31. **Slide ops verified live**: context (GetSlidesCount/
   GetSlideByIndex/GetCurSlideIndex + GetDrawingsByPlaceholderType
   'title'/'ctrTitle'/'body' + shape GetContent().GetElement(i)
   .GetText()); rewriteSlide (lookups BEFORE writes — a missing body
   placeholder errors atomically, nothing is written: verified by
   reading back the untouched title); insertSlideAfter (CreateSlide +
   two rect shapes with title/body placeholders + AddSlide + MoveTo —
   s0 → index 0 and sN==count → append at end both verified).
   Slide context reports hasTitle/hasBody so the agent sees which
   slides can take a body rewrite.
32. Reinstall gotchas (5 rounds learned): the Plugin Manager does NOT
   always replace a running install (verify the ON-DISK code, not the
   panel status); a plugin tab opened before the reinstall keeps
   running the OLD code until closed and reopened; the panel status
   line cannot tell versions — trust the hello (`version` in
   /bridge/hello). Editor restarts do not re-open plugin panels.
33. v1 slide limitation (by design): no selected-frame `rewrite` —
    the plugin sandbox cannot address a selected shape yet (needs an
    ApiSelection probe); the impress vocabulary is rewrite-slide +
    insert-after only. Calc is active-sheet-only (no sheet switching
    op). Both are documented in the action instructions themselves.

## Packaging (2026-11-03) — win-unpacked verified

electron-builder config added to package.json (mirrors the LO app:
nsis/portable/zip on win, dmg/zip on mac, AppImage/deb/tar.gz on
linux; `acp-bridge.plugin` rides along as an extraResource). The app
gained its own brand assets: `public/logo.svg` (ONLYOFFICE-orange
variant of the shared card+spark logo; wired as `assetsDir` in both
electron main and standalone) and `build/icon-256.png`/`icon-512.png`/
`icon.ico` (PIL-generated from the same design — regenerate with a
script, they are not exported from the SVG).

Packaged win-unpacked verified: asar bundles the app dist, the
`public/logo.svg` override, `@acp-assist/core` (incl. companion.js)
and the full `@acp-assist/panel` (dist + all 13 public modules); the
packaged exe boots, serves index/app.js/logo.svg//panel-boot.js (token
+ OO config) and answers `/api/status` with the bearer token.

34. **VS Code locks freshly packaged output INSIDE the repo**: a VS
    Code utility process (file watcher; identified via the Restart
    Manager API) holds an exclusive lock on extracted electron files
    (`default_app.asar`), so electron-builder's win-unpacked.tmp →
    win-unpacked rename fails with EPERM/EBUSY and the partial dirs
    cannot even be deleted. CI is unaffected. Workaround: package with
    the output directory OUTSIDE the VS Code-watched workspace —
    `npx electron-builder --dir --publish never
    -c.directories.output=<abs path outside the repo>` — or close VS
    Code first. The gitignored `dist-release/` default stays fine for
    CI and for users who don't keep the repo open in VS Code.

## Live agent round-trips + the v0.3.6 white-text bug (2026-11-03)

Both remaining live gates PASSED through the REAL companion (Electron
panel app on 8790) + vibe-acp: calc (write-cells "Region"/"Sales" at
A1/B1 — confirmed by the agent's own step-2 re-read; outline shows the
sheet's used range grew to A1:B1) and slides (insert-after — visually
confirmed by the user AFTER the v0.3.6 fix below). The slide round-trip
caught a real bug the Phase 3 read-backs could not see:

35. **Synthetic-shape text renders INVISIBLE — API reads cannot see
    rendering.** insertSlideAfter builds its slide from fresh
    Api.CreateShape('rect') shapes with a white solid fill, and the
    text written into those shapes rendered in an (apparently
    theme-default) WHITE color: the user saw empty slides/canvas while
    every bridge read returned the title text back "clean" — the exact
    reason Phase 3's read-only verification missed it. v0.3.6 fix:
    setShapeParas gained a forceBlack param — every run created for the
    SYNTHETIC shapes gets run.SetColor(0,0,0); themed placeholders
    (rewriteSlide) keep their theme color. Verified live: the
    re-inserted "Roadmap" slide is visibly black on canvas + thumbnail.
    RULE: any change touching how content RENDERS needs a human eyeball
    on the editor canvas; reads alone prove nothing about visibility.
    Caveat: rewriting a slide whose shapes came from a v0.3.5-era
    insert (synthetic, white text) keeps the invisible color — those
    decks should re-insert rather than rewrite, or delete the affected
    slide.
36. **Post-reinstall stall (beyond rule 32):** after Remove + manual
    .plugin install, a reopened bridge tab showed "connected" but its
    poll loop was dead — the panel-side /api/status stayed
    bridgeAvailable:false for minutes while an ESTABLISHED socket sat
    idle. Clicking the plugin's own Reconnect button revived it
    immediately. After any reinstall: click Reconnect (or close/reopen
    the tab) AND confirm the companion's status flips before testing.
37. **pluginStaleMs (30s) vs the 20s poll window is fragile, and CEF
    throttles plugin timers in a backgrounded editor window**: while
    ONLYOFFICE is backgrounded (the user chatting elsewhere), the
    long-poll cycle can gap > 30s → isConnected() false → the panel
    shows "not connected" and messages are refused with the misleading
    "open the plugin" error, even though the plugin is fine. Two real
    messages failed this way before "keep ONLYOFFICE foreground" fixed
    it. Follow-up candidates (not done): raise pluginStaleMs (e.g.
    90s), or drop the gate and let op()'s own 30s timeout decide.
38. The UNSAVED conversation key (v1, no file path in the sandbox) also
    shares chat HISTORY across editors: the slide session replayed the
    calc session's turns. Known v1 behavior, now concretely observed.

## P5 design-probe research (2026-11-03) — v0.4 "modern design + images"

Probed live against Desktop Editors 10.0.0.169 with the probe plugin
v0.2.1 (P5 command batch: slideInfo, insertImage, setBackground,
applyTheme, styleTitle, applyLayout, deleteSlide, addNotes,
setTransition) driven through `spike/probe-server/server.mjs`
(log beside it). All probes self-contained `new Function(...)` sources
— see rule 39.

39. **callCommand SERIALIZES the function source — closures do not
    survive.** A wrapper whose body referenced an outer `fn` variable
    executed as `ReferenceError` inside the document context and the
    callCommand callback fired with `undefined` (no error surfaced).
    Every callCommand body must be a self-contained source string
    (args via `Asc.scope`) — the bridge plugin's `new Function(src)`
    pattern is not a style choice, it is a hard requirement. Also:
    `typeof Api.GetPresentation` still throws if `Api` itself is
    undefined — guard with `typeof Api === 'undefined'` first.
40. **The whole design surface EXISTS in the desktop build** (P5
    slideInfo + live probes): `Api.CreateImage` (URL AND base64 data
    URI), `CreateBlipFill`, `slide.SetBackground`, `CreateTheme` +
    all scheme factories + `slide.ApplyTheme`, `ApplyLayout`,
    `slide.Delete`, `AddNotesText`, `Get/SetSlideShowTransition` +
    `Api.CreateSlideShowTransition`, run styling (`SetBold`/
    `SetFontSize`/`SetFontFamily`/`SetFill` on ApiRun; `SetColor`
    visually verified by the v0.3.6 fix). 11 layouts on the default
    master (enumerated bounded via `master.GetLayout(i)`; there is no
    count accessor).
41. **Images: stored correctly, rendered only after reopen.**
    `CreateImage` (URL) downloads and embeds byte-exact (ppt/media
    matched the source file size) and the data URI embeds too — but
    the LIVE canvas keeps showing EMPTY frames until the document is
    closed and reopened. Tab switching away/back does NOT repaint;
    an `ApplyLayout` "nudge" command does NOT repaint. Product
    implication: v0.4 image ops are viable, but the panel must tell
    the user images appear after save+reopen (or a live-repaint
    trigger needs more research — none of the three tried worked).
42. **`SetBackground` DOES repaint live** (radial gradient verified
    visible on canvas + thumbnail immediately). So the repaint gap is
    specific to raster-image content arriving asynchronously after
    the callCommand transaction.
43. **`ApplyTheme`/`ApplyLayout` apply but disturbed the existing
    slide's placeholders**: after applyLayout(0)+applyTheme the
    title/subtitle prompt text rendered OVERLAPPING (user-verified
    visual corruption). Not yet separated which of the two caused it
    — a follow-up probe must test them in isolation before either
    becomes a product op. Per-slide backgrounds + styled text are
    the safe design surface; whole-theme changes are NOT ready.
44. **Notes + transitions fully work**: `AddNotesText` visible in the
    notes pane immediately; `CreateSlideShowTransition` +
    `SetSlideShowTransition` apply cleanly. `slide.Delete()` works
    (1→0 slides, one undo step presumed — deck was discarded).
45. **The blank deck's title placeholder is `ctrTitle`**, not `title`
    — the P5 styleTitle probe missed it (the bridge already handles
    both, rule 31). Placeholder lookup in any new op must check
    `title` AND `ctrTitle`.

## v0.4 design surface (2026-11-03) — built from the P5 probe findings

Bridge plugin v0.4.0 + companion impress adapter (plugin + companion
ship together — the slide-content WIRE changed: title/body are now
{text, style?} objects, plain strings still tolerated plugin-side):

- **New impress actions**: `[ACTION: insert-image sN]` (http(s)/data-URI
  sources, `at:`/`size:` with %-/in-/EMU measurements, defaults 20%
  wide centered on the current slide), `[ACTION: set-background sN]`
  (solid/gradient/image), `[ACTION: add-notes sN]`,
  `[ACTION: delete-slide sN]`. Per-line run styling in every slide
  content line: `{bold; italic; size=28; color=#rrggbb; font=Georgia}`
  prefix (tolerant — unknown attrs ignored). The slide context now
  reports per-slide image counts.
- **setShapeParas v2** (plugin source): structured {t, st} lines, every
  run setter guarded, hex→RGB in-source; `forceBlack` (rule 35) now
  applies per line only when the line has NO explicit color — so a
  styled synthetic line with `color=` keeps its color.
- **insertImage op** embeds correctly but RENDERS only after save+
  reopen (rule 41) — the adapter's action description carries that
  hint and the agent instructions tell it to say so in the reply.
- **setBackground** repaints live (rule 42) — no reopen needed.
- **setTransition is NOT an action** (the factory's parameter shape is
  undocumented; probed only as availability). Theme/layout application
  stays OUT (rule 43 corruption).
- Gates: OO 34/34 vitest (+6: style prefix, image-block parsing +
  validation + defaults, background parsing, add-notes/delete-slide
  mapping, structured-line wire), typechecks clean.

## v0.4 LIVE VERIFICATION (2026-11-03, plugin v0.4.2 + companion fix)

Every new v0.4 action ran through the REAL companion (Electron, 8790)
+ vibe-acp and was VISUALLY verified (rule 35) in the user's editor:
styled rewrite-slide (title "Modern Deck": LARGE bold orange Georgia —
44pt now correct after the half-point fix, italic body line),
set-background s1 (white→ff6f3d radial gradient visible on canvas AND
thumbnail IMMEDIATELY — rule 42 confirmed in the product),
insert-image s1 (logo embedded; empty frame until save+reopen —
rule 41 confirmed; renders after reopen, user-verified),
add-notes s1 (visible in the notes pane), and delete-slide s1 (the
agent used it unprompted in a multi-action run — old blank slide
deleted, styled slide survived). The multi-action loop carried the
new actions cleanly.

The live pass caught three more real bugs — all fixed + re-verified:

46. **The /bridge/next poll-swallowing bug (COMPANION)**: the old
    timeout handler only responded `if (this.waiter)` — with two
    overlapping long-polls (a stale fetch from before a reconnect),
    the first timer nullified the second's waiter, so the second
    poll's fetch HUNG FOREVER: the plugin's poll loop died while its
    status text still said "connected", and the companion refused
    every message. Fix: every poll now gets EXACTLY ONE response
    from ITS OWN timer (`wrapper`/`mine` closures in
    plugin-bridge.ts); overlapping polls are safe (each responds on
    its own schedule). This likely explains several earlier
    "connected but bridgeAvailable:false" mysteries.
47. **cmd() timeouts must REJECT, never resolve as data (PLUGIN)**:
    the old 30s timeout resolved with {error: "..."} — detectEditor
    assigned that OBJECT to editorType, poisoning every op with
    "editor '[object Object]'" until a reinstall. Fix: the timeout
    now rejects (init's catch shows unreachable + retries), and init
    validates the detected editor id (word/cell/slide) before using
    it. An `initializing` guard also prevents stacked inits from the
    reconnect-button/unreachable-retry race.
48. **ApiRun.SetFontSize takes HALF-POINTS (hps), not points**: the
    agent's "44pt" landed as 22pt (smaller than the body!). The
    style prefix stays points (human/LLM friendly); the plugin's
    lineObj multiplies by 2 before SetFontSize.

## Probe artifacts (spike/)

- `probe-plugin/` — the probe plugin sources (config.json, index.html,
  scripts/code.js: P1–P4 + P5 design-probe instrumentation, long-poll
  client, report()). **v0.2.1** — P5 batch + self-contained callCommand
  sources (rule 39); installed in the user's editors as v0.2.1.
- `acp-probe.plugin` — packaged artifact (Compress-Archive + rename).
  Repackage after editing probe sources. (A stray copy sits on the
  user's Desktop: `acp-probe-v0.2.plugin`.)
- `probe-server/server.mjs` — zero-dep Node companion (CORS-open,
  long-poll command channel, /report logging). Start with
  `node server.mjs`; logs to `probe-server.log`.
- The probe plugin remains installed in the user's Desktop Editors
  (Plugins tab → "ACP Assist Probe") for future sessions. Remove via
  Plugin Manager if needed.