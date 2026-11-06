# ACP Assist

[![Tests](https://github.com/guzmandrade-dev/acp-assist/actions/workflows/test.yml/badge.svg)](https://github.com/guzmandrade-dev/acp-assist/actions/workflows/test.yml)
[![Build](https://github.com/guzmandrade-dev/acp-assist/actions/workflows/build.yml/badge.svg)](https://github.com/guzmandrade-dev/acp-assist/actions/workflows/build.yml)

**Website:** <https://guzmandrade-dev.github.io/acp-assist/>

Copilot-style LLM assistants for document editors. Each app is a floating
companion panel that reads your document, chats, and writes **directly into
the live editor document**. All reasoning is delegated to an external agent
over the [Agent Client Protocol](https://agentclientprotocol.com/) (ACP);
there is no LLM and no API key inside these apps.

| App | Description |
|---|---|
| **[ACP Assist](apps/acp-assist)** | **One installer for all three editors** — bundles LyX, LibreOffice, and ONLYOFFICE behind an in-app switcher (one active at a time; per-app, per-document history) |
| **[LyX ACP Assist](apps/lyx)** | Assistant for [LyX](https://www.lyx.org/) — writes through the LyXServer named pipe and the `application/x-lyx` clipboard format, so LyX itself performs every insertion |
| **[LibreOffice ACP Assist](apps/libreoffice)** | Assistant for [LibreOffice](https://www.libreoffice.org/) — Writer, Calc, and Impress via a small in-process UNO bridge (`.oxt`) with per-module adapters |
| **[ONLYOFFICE ACP Assist](apps/onlyoffice)** | Assistant for [ONLYOFFICE Desktop Editors](https://www.onlyoffice.com/desktop.aspx) — Documents, Spreadsheets, and Presentations via a small in-editor JavaScript plugin (`.plugin`) that connects out to the companion |

All three apps share one architecture: the editor stays the **single writer of
truth**, the agent decides intent via a small vocabulary of action tags that
the app executes mechanically, and every edit is one undo step. The panel is
a quiet chat surface that floats beside the document.

## Repository layout

```
packages/core/    @acp-assist/core: shared ACP client, types, attachment
                  conversion, chat-history persistence, restart replay
packages/panel/   @acp-assist/panel: the shared companion panel UI + Electron/
                  standalone shell hosts
apps/acp-assist/  Unified companion: one app, in-app switcher between the
                  three editors (multi-backend host around the same servers)
apps/lyx/         LyX companion (Electron + read-only .lyx parser + pipe client)
apps/libreoffice/  LibreOffice companion (Electron + UNO bridge + module adapters)
apps/onlyoffice/  ONLYOFFICE companion (Electron + in-editor .plugin bridge)
```

npm workspaces: install once at the root (`npm install`), then develop,
test, and package from any app's directory. `@acp-assist/core` rides along
as a regular workspace dependency. CI packages and releases **only the
unified app** (`apps/acp-assist`) — one installer for all three editors;
the per-editor apps remain in the repo for development, testing, and
documentation. See each app's README for requirements and usage.

## Development

Node.js 22+. From either app's directory:

```bash
npm install
npm test         # vitest
npm run typecheck
npm start        # builds TypeScript and launches the Electron companion
npm run package  # installers for Windows, macOS, and Linux
```

## History

This repository absorbed the full histories of the former standalone
repositories `lyx-acp-assist` and `libreoffice-acp-assist`. Earlier commits
were rewritten so their file paths match this layout; commit messages,
authorship, and ordering are preserved. SHAs differ from the old
repositories.