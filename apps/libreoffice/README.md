# LibreOffice ACP Assist

A Copilot-for-Office-style AI assistant for [LibreOffice](https://www.libreoffice.org/)
— a floating companion panel that reads your document, chats, and writes
**directly into the live LibreOffice document** across **Writer, Calc, and
Impress**. All reasoning is delegated to an external agent over the
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP); there is
no LLM and no API key inside this app.

LibreOffice stays the editor. The app is a chat surface plus a context
provider, and every edit is one labeled, one-click-undoable transaction.

> **Note (v1.6.0+):** releases ship only the unified
> **[ACP Assist](../../apps/acp-assist)** app — one installer for LyX,
> LibreOffice, and ONLYOFFICE. This workspace remains for development,
> testing, and documentation; `npm start` / `npm run package` still work
> here for development builds.

## How it works

```
┌──────────────┐   ACP (stdio JSON-RPC)   ┌─────────────────┐
│  ACP agent   │◄────────────────────────►│  Electron       │
│ (vibe-acp,   │                          │  companion       │
│  copilot,    │                          │  (chat panel)    │
│  goose, …)   │                          └───────┬─────────┘
└──────────────┘                                  │ HTTP (localhost)
                                          ┌───────▼─────────┐
                                          │  UNO bridge      │
                                          │  inside LibreOffice│
                                          │  (small .oxt)    │
                                          └───────┬─────────┘
                                                  │ UNO API
                                          ┌───────▼─────────┐
                                          │ Writer / Calc /  │
                                          │ Impress document │
                                          └──────────────────┘
```

- **Electron companion** (shared with the LyX app): floating chat panel,
  Express API, streaming responses, file attachments, per-document history.
- **ACP client** (shared): agent-agnostic — `vibe-acp`, `copilot --acp`,
  `goose acp`, or any ACP-speaking CLI.
- **UNO bridge**: a small Python `.oxt` extension that runs inside
  LibreOffice and exposes read/write/event operations on the active
  document over localhost HTTP. It is deliberately dumb — all intelligence
  lives in the companion, and the same bridge serves every module.
- **Module adapters**: per-module context building and action execution.

The document is never read or written behind LibreOffice's back: the
companion talks to the bridge, and the bridge performs every operation
through UNO in a single undo transaction per edit.

## Demo
https://github.com/user-attachments/assets/d022ecfd-9af4-4eaa-a621-e748b3d4ea04

## Requirements

- **LibreOffice** (Writer, Calc, and/or Impress)
- **Node.js 22+**
- **An ACP agent CLI** — any of `vibe-acp`, `copilot --acp`, or
  `goose acp`. Configurable at runtime in the app's "Agent settings"
  panel.

## Getting started

```bash
npm install
npm start        # builds TypeScript and launches the companion
```

The bridge extension is not installed automatically. If no bridge is
found and LibreOffice is installed, the panel's status line shows an
**Install bridge…** button: close LibreOffice first, click the button,
restart LibreOffice, then start the bridge from the menu
(**ACP Assist > Start bridge**).

Manual install also works — LibreOffice's Extension Manager, or
`unopkg add` from LibreOffice's `program` directory. If the sidebar deck
shows up empty after an install, delete `user/uno_packages/cache/` in
your LibreOffice profile and restart.

### Other office suites (Collabora Office, Apache OpenOffice)

The bridge is a plain Python-UNO extension, so any UNO-based office suite
can host it — not just LibreOffice. To point the one-click install at a
different suite, add an `officePath` to the persisted agent settings
(`agent-settings.json` next to the ACP `command`, or via
`PUT /api/settings/agent`):

```json
{
  "command": "vibe-acp",
  "officePath": "C:\\Program Files\\Collabora\\CollaboraOffice"
}
```

`officePath` may be the installation root (the directory containing
`program/`), the `program/` directory itself, or the `unopkg` binary.
The suite is detected from `program/versionrc`/`version.ini` (or the
directory name) and the matching user profile is used for the install —
e.g. `%APPDATA%\Collabora` for Collabora Office, `%APPDATA%\OpenOffice`
for Apache OpenOffice. For a non-standard profile location, set the
`LO_USER_PROFILE` environment variable to the profile's `user/` dir.
Note: the bridge is a Python UNO component, so the target office needs a
Python script provider in its `program/` dir. LibreOffice and Collabora
Office bundle one. Apache OpenOffice does not by default — the .oxt still
installs, but it will not load until you add the bridge:

- **Windows/macOS**: re-run the AOO installer, choose **Modify**, and under
  *Optional Components* install the **Python-UNO bridge** (recent AOO
  versions offer it there; it drops `program/python.exe` into the
  installation).
- **Linux**: install your distro's pyuno package for OpenOffice
  (e.g. `openoffice.org-pyuno` on Fedora).

Once `program/python[.exe]` exists, the preflight `warning` disappears.
If that is too much hassle, the simplest alternative is to point
`officePath` at LibreOffice or Collabora Office instead — both bundle
Python and need no extra step. The preflight endpoint reports the
resolved `unopkg`, the detected `vendor`, and a `warning` when the
target office bundles no Python.

## One input box, agent-decided intent

You type a single message; the agent decides whether to reply in chat or
edit the document, and ends its reply with an action tag the app executes.
The vocabulary is module-specific.

**Common:** `[ACTION: none]` — prose reply, document untouched.

**Writer** (paragraphs addressed as `[pN]`):

| Action | Effect |
|---|---|
| `[ACTION: insert]` | Insert at the cursor |
| `[ACTION: insert-after pN]` | Insert new paragraph(s) after `[pN]` |
| `[ACTION: rewrite]` | Replace the active selection |
| `[ACTION: rewrite-at pN]` | Replace paragraph `[pN]` (verified first) |
| `[ACTION: delete-at pN]` | Delete paragraph `[pN]` |
| `[ACTION: read-paragraph pN]` | Read-only: fetch the full text of `[pN]` (outline previews are truncated in large documents); the app re-prompts the agent with it |

**Calc** (active sheet + selection surfaced as TSV with values *and*
formulas, cells addressed as `A1`):

| Action | Effect |
|---|---|
| `[ACTION: write-cells]` | Write a TSV block at the selection's top-left cell; `[ACTION: write-cells B2]` anchors it at `B2` |
| `[ACTION: rewrite]` | Replace the selected cells |
| `[ACTION: insert-rows]` / `[ACTION: insert-rows A5]` | Insert an empty row above the selection / cell |
| `[ACTION: insert-cols]` / `[ACTION: insert-cols C1]` | Insert an empty column left of the selection / cell |
| `[ACTION: format-cells]` / `[ACTION: format-cells B2]` / `[ACTION: format-cells A1:B10]` | Restyle the selection / cell / range — values untouched. The `calc` block carries one style line: `{bg=#fff2cc; color=#c00000; bold; italic; underline; size=14; font=Arial}` |

**Impress** (slides addressed as `[sN]`):

| Action | Effect |
|---|---|
| `[ACTION: rewrite]` | Replace text in the selected frame(s) |
| `[ACTION: insert-after sN]` | New slide(s) after `[sN]` (title + body layout) |
| `[ACTION: rewrite-slide sN]` | Replace a slide's outline text |

Draw is reachable through the Impress adapter. Math and Base are out of
scope for now.

## Reviewing and undoing edits

In **Writer and Calc**, agent edits land as tracked changes by default:
you accept or reject each one in LibreOffice's *Edit > Track Changes >
Manage*, like reviewing a diff. A quick Ctrl+Z also reverts an edit as a
whole — every edit is one undo transaction.

**Impress and Draw** have no change tracking, so edits land directly;
the panel's Undo button reverts them one edit per click, using the
bridge's undo journal.

## Multiple instances

No fixed ports: each bridge binds an OS-assigned localhost port and
writes a discovery record (port + auth token) into a well-known
per-user directory (`%APPDATA%\<app>\bridges` on Windows,
`~/Library/Application Support/<app>/bridges` on macOS,
`~/.config/<app>/bridges` on Linux). The companion scans it, drops stale
records, and lists every running LibreOffice instance. Multiple
LibreOffice profiles and multiple companions side by side just work.

One companion session talks to one bridge at a time — it attaches to the
most recently started LibreOffice instance it finds. All live instances
are visible in the panel; switching to another one is a reconnect.

## Features

- Multi-module support: Writer, Calc, Impress (and Draw via Impress)
- Streaming responses, stop/cancel, one-click undo per edit
- Live selection and cursor events update the panel as you move
- File attachments (PDF, Office, text…) converted to text for the agent
- Per-document chat history, persisted

## Development

```bash
npm test         # vitest (unit + mocked-bridge integration)
npm run typecheck
npm run build
npm run package  # installers for Windows (nsis/portable/zip), macOS (dmg/zip),
                 # Linux (AppImage/deb/tar.gz) via electron-builder
```

Tests are plain vitest and run on any OS. GitHub Actions runs the test
suite on both Ubuntu and Windows; installers for all three OSes are
built only when a `v*` tag is pushed or on a manual workflow dispatch.

```
src/server.ts       Express API + bridge discovery/healing
src/bridge/         bridge client, .oxt install (unopkg)
src/modules/        per-module adapters (writer, calc, impress)
extension/          the UNO bridge .oxt (Python)
public/             companion panel UI (shared with the LyX app)
```

Shared code (ACP client, attachment conversion, chat-history persistence,
restart replay, the panel) lives in the workspace packages
[`@acp-assist/core`](../../packages/core) and
[`@acp-assist/panel`](../../packages/panel) at the monorepo root. The
sibling app [LyX ACP Assist](../lyx) uses the same architecture.

Status, decisions, and verified technical facts live in
[AGENTS.md](AGENTS.md).
