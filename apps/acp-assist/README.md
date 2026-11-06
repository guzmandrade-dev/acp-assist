# ACP Assist (unified)

**One installer, three editors.** This app bundles the LyX, LibreOffice,
and ONLYOFFICE companions into a single application with an in-app
switcher (the dropdown in the panel's toolbar). One editor app is active
at a time; each app keeps its own sessions and its own per-document
chat history under the app's profile directory (`history/<app>`), so
switching never mixes conversations.

## How it works

- One Electron window + one Express host (`src/server.ts`) running the
  three companion backends side by side.
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
