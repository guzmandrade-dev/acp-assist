# ACP Assist (unified)

**One installer, three editors plus PDF review.** This app bundles the LyX,
LibreOffice, and ONLYOFFICE companions into a single application with an
in-app switcher (the dropdown in the panel's toolbar), plus a fourth
**PDF Review** entry for discussing a compiled PDF. One app is active
at a time; each app keeps its own sessions and its own per-document
chat history under the app's profile directory (`history/<app>`), so
switching never mixes conversations.

## Install

Since v1.6.0 this is the **only app that is packaged and released**: each
[GitHub release](https://github.com/guzmandrade-dev/acp-assist/releases)
ships the ACP Assist installers for Windows, macOS, and Linux, plus the
bridge files (`acp-bridge.oxt` for LibreOffice, `acp-bridge.plugin` for
ONLYOFFICE) for editor-side install — the installers bundle copies of both
in `resources/`.

## How it works

- One Electron window + one Express host (`src/server.ts`) running the
  three companion backends side by side.
- The app's version (from `package.json`) is injected into the panel's
  boot config and shown in the settings popover next to **Check for
  updates**. On startup (and on demand) the main process asks the GitHub
  releases API for the latest *published* release; when it is newer,
  Windows/macOS offer to download the installer asset (nsis `.exe` /
  `.dmg`) into the Downloads folder and hand it to the OS, while Linux
  just opens the releases page (no safe auto-install there). See
  `src/electron/updater.ts` + `updater-core.ts`.
- The panel loads as `/?app=<id>`; the boot script carries an
  app-scoped bearer token (`<app>:<raw>`), so every `/api/*` request is
  dispatched to the selected app's sub-server (which re-validates the
  raw token with its own guard).
- The ONLYOFFICE in-editor plugin connects OUT to a well-known port
  (default **8790**) over the pre-auth `/bridge/*` endpoints, which the
  host always routes to the ONLYOFFICE sub-server (loopback-only).
- The app is single-instance: a second launch just focuses the existing
  window. If port 8790 is already taken by a *foreign* process, the server
  falls back to an OS-assigned port — the actual port is shown in the
  window title, logged, and written to the discovery record; point the
  plugin's port field at it.
- The LibreOffice sidebar reads the usual `companion.json` discovery
  record; the unified app writes it with `?app=libreoffice` in the URL
  and the app-scoped token.
- The window floats over whichever bundled editor is focused
  (LyX / soffice / editors).
- Fourth switcher entry **PDF Review** (`?app=pdf`): a prose-only chat
  about a read-only PDF, with the conversation keyed by the PDF path
  (`history/pdf/`). PDFs are opened at their REAL filesystem path —
  "Open in viewer" picks one via the native dialog when none is open
  (`acp:pick-pdf` IPC), and attaching a PDF uses `webUtils.getPathForFile`
  so no hashed upload copy is shown; the upload copy is only a fallback
  in the standalone host. The PDF backend lives in `@acp-assist/core`
  (`createPdfBackend` + `createPdfExtraRoutes`): `POST .../pdf/open`
  opens a PDF (path or uploaded attachment), `POST .../open-external`
  and `POST .../jump` open the PDF in the user's viewer — SumatraPDF
  with `-reuse-instance -page <N>` when detected on Windows, else the
  OS default — and the shared `POST .../review` route produces the
  structured report (page-aware text + optional page images + history,
  schema-validated with one conversion retry), rendering suggestions in
  the panel. Nothing is written into the app's data dir: `GET
  .../review/download` serves the last review as a ZIP (flat
  `report.html` + `report.json`) that the panel downloads. In this mode
  the panel swaps the Undo button for Review… and Open-in-viewer
  (`pdfMode` panel flag), and chat is refused until a PDF is open.

## Development

Node.js 22+. From this directory:

```bash
npm install        # run once at the repo root instead (workspaces)
npm test           # vitest (dispatch/routing tests)
npm run typecheck
npm start          # builds the bundled apps, then launches Electron
npm run package    # installers for Windows, macOS, and Linux
```

The LibreOffice bridge `.oxt` and the ONLYOFFICE `.plugin` are packaged
as extra resources; `npm run package` rebuilds them from the sibling
apps first.
