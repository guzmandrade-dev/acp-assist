# ONLYOFFICE ACP Assist

A Copilot-for-Office-style AI assistant for [ONLYOFFICE Desktop
Editors](https://www.onlyoffice.com/desktop.aspx) — a floating companion
panel that reads your document, chats, and writes **directly into the live
document** across **Documents (word processor), Spreadsheets, and
Presentations**. All reasoning is delegated to an external agent over the
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP); there is
no LLM and no API key inside this app.

ONLYOFFICE stays the editor. The app is a chat surface plus a context
provider, and every edit is one labeled, one-undo-step transaction.

## How it works

```
┌──────────────┐   ACP (stdio JSON-RPC)   ┌─────────────────┐
│  ACP agent   │◄────────────────────────►│  Electron       │
│ (vibe-acp,   │                          │  companion       │
│  copilot,    │                          │  (chat panel)    │
│  goose, …)   │                          └───────┬─────────┘
└──────────────┘                                  │ HTTP (localhost, fixed port)
                                          ┌───────▼─────────┐
                                          │  bridge plugin   │
                                          │  inside the      │
                                          │  ONLYOFFICE      │
                                          │  editor (.plugin)│
                                          └───────┬─────────┘
                                                  │ Office JavaScript API
                                          ┌───────▼─────────┐
                                          │  Document /     │
                                          │  Spreadsheet /  │
                                          │  Presentation   │
                                          └─────────────────┘
```

- **Electron companion** (shared with the LyX and LibreOffice apps):
  floating chat panel, Express API, streaming responses, file
  attachments, per-document history.
- **ACP client** (shared): agent-agnostic — `vibe-acp`, `copilot --acp`,
  `goose acp`, or any ACP-speaking CLI.
- **Bridge plugin**: a small JavaScript `.plugin` that runs inside
  ONLYOFFICE Desktop Editors and exposes read/write operations on the
  active document over localhost HTTP. It is deliberately dumb — all
  intelligence lives in the companion, and the same bridge serves every
  module.
- **Module adapters**: per-module context building and action execution.

The transport direction is inverted from the LibreOffice app: the plugin
connects **out** to the companion on a fixed localhost port (default
`8790`), so no port discovery is needed. The document is never read or
written behind the editor's back: the companion sends JSON operations,
and the plugin performs each one through the Office JavaScript API inside
a single `callCommand` — one undo step per edit.

## Requirements

- **ONLYOFFICE Desktop Editors** (verified against 10.0; the free AGPL
  desktop suite — not the cloud/Docs versions)
- **Node.js 22+**
- **An ACP agent CLI** — any of `vibe-acp`, `copilot --acp`, or
  `goose acp`. Configurable at runtime in the app's "Agent settings"
  panel.

## Getting started

1. **Start the companion**

   ```bash
   npm install
   npm start        # builds TypeScript and launches the companion
   ```

2. **Install the bridge plugin** (one time, per editor install)

   The plugin is *not* installed automatically — the editor's sandbox
   only accepts installs through its own Plugin Manager. Build the
   plugin package and install it in ONLYOFFICE:

   ```bash
   npm run package:plugin   # → acp-bridge.plugin (a renamed zip)
   ```

   In ONLYOFFICE: **Plugins** tab → **Plugin Manager** → **Install
   plugin manually** → pick `acp-bridge.plugin`. No restart, no
   approval needed. (The packaged app ships the same file next to the
   executable under `resources/`.)

3. **Connect**: open the **ACP Assist Bridge** plugin from the editor's
   **Plugins** tab. It connects to the companion (port 8790 by default;
   changeable in the plugin's port field) and the panel's status line
   turns green. The plugin tab must stay open while you chat.

## One input box, agent-decided intent

You type a single message; the agent decides whether to reply in chat or
edit the document, and ends its reply with an action tag the app executes.
The vocabulary is module-specific.

**Common:** `[ACTION: none]` — prose reply, document untouched.

**Documents** (paragraphs addressed as `[pN]`):

| Action | Effect |
|---|---|
| `[ACTION: insert]` | Insert at the cursor |
| `[ACTION: insert-top]` | Insert at the very beginning of the document |
| `[ACTION: insert-after pN]` | Insert new paragraph(s) after `[pN]` |
| `[ACTION: rewrite]` | Replace the active selection |
| `[ACTION: rewrite-at pN]` | Replace paragraph `[pN]` |
| `[ACTION: delete-at pN]` | Delete paragraph `[pN]` |

Markdown in the content block maps to native document formatting:
headings, quotes, code blocks, and bold/italic runs.

**Spreadsheets** (active sheet surfaced as TSV with values *and*
formulas, cells addressed as `A1`):

| Action | Effect |
|---|---|
| `[ACTION: write-cells]` | Write a TSV block at the selection's top-left cell; `[ACTION: write-cells B2]` anchors it at `B2` |
| `[ACTION: rewrite]` | Replace the selected cells |
| `[ACTION: insert-rows]` / `[ACTION: insert-rows A5]` | Insert an empty row above the selection / cell (formulas auto-adjust) |
| `[ACTION: insert-cols]` / `[ACTION: insert-cols C1]` | Insert an empty column left of the selection / cell |

**Presentations** (slides addressed as `[sN]`):

| Action | Effect |
|---|---|
| `[ACTION: rewrite-slide sN]` | Replace a slide's outline text (title first; per-line `{bold; color=#ff6f3d; size=28; font=Georgia}` style prefixes supported) |
| `[ACTION: insert-after sN]` | New slide after `[sN]` (`s0` = the very start; nothing is written if the block is invalid) |
| `[ACTION: insert-image sN]` | Place an image on slide `[sN]` (current slide without a number) — URL or base64 source, optional `at:`/`size:` placement; the image appears after saving and reopening the file |
| `[ACTION: set-background sN]` | Slide background: `solid #rrggbb`, `gradient #rrggbb-#rrggbb`, or `image <URL>` |
| `[ACTION: add-notes sN]` | Add speaker notes to slide `[sN]` |
| `[ACTION: delete-slide sN]` | Delete slide `[sN]` |

## Reviewing and undoing edits

Edits land directly in the document (ONLYOFFICE has no UNO-style change
tracking reachable from plugins). Every edit is a single undo step:
**Ctrl+Z in ONLYOFFICE reverts one agent edit per press**. The panel's
Undo button tells you when the editor cannot be driven programmatically
and points you at Ctrl+Z.

## Limitations (v1)

- **One editor window per session**: the plugin reports the active
  document; keep a single document open per editor window while a
  session is live.
- The plugin sandbox cannot see the file path — the conversation is
  keyed as "unsaved" per document (chat history does not follow the
  file across editor restarts).
- Selection changes reach the panel via a short poll (about 2s), not
  push events — the editor's plugin event API accepts subscriptions
  but never fires them.

## Development

```bash
npm test         # vitest (unit + fake-bridge integration)
npm run typecheck
npm run build
npm run package  # .plugin zip + installers for Windows (nsis/portable/zip),
                 # macOS (dmg/zip), Linux (AppImage/deb/tar.gz) via electron-builder
```

Tests are plain vitest and run on any OS; the bridge is faked, no editor
needed. Live verification against a real editor uses the spike harness
under `spike/` (see [AGENTS.md](AGENTS.md) for the recorded findings).

```
src/server.ts       Express API + module dispatch (CompanionBackend)
src/bridge/         plugin-facing endpoints (long-poll job queue)
src/modules/        per-module adapters (writer, calc, impress)
bridge-plugin/      the in-editor bridge plugin (.plugin source)
scripts/            .plugin packaging
spike/              probe + drive harnesses used for live verification
```

Shared code (ACP client, companion core, attachment conversion,
chat-history persistence, restart replay, the panel) lives in the
workspace packages [`@acp-assist/core`](../../packages/core) and
[`@acp-assist/panel`](../../packages/panel) at the monorepo root. The
sibling apps [LyX ACP Assist](../lyx) and
[LibreOffice ACP Assist](../libreoffice) use the same architecture.

Status, decisions, and verified technical facts live in
[AGENTS.md](AGENTS.md).
