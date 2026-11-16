# ACP Assist

[![Tests](https://github.com/guzmandrade-dev/acp-assist/actions/workflows/test.yml/badge.svg)](https://github.com/guzmandrade-dev/acp-assist/actions/workflows/test.yml)
[![Build](https://github.com/guzmandrade-dev/acp-assist/actions/workflows/build.yml/badge.svg)](https://github.com/guzmandrade-dev/acp-assist/actions/workflows/build.yml)
[![Security scanning](https://github.com/guzmandrade-dev/acp-assist/actions/workflows/security.yml/badge.svg)](https://github.com/guzmandrade-dev/acp-assist/actions/workflows/security.yml)
[![Scanners](https://img.shields.io/badge/scanners-CodeQL%20%C2%B7%20Semgrep%20%C2%B7%20Gitleaks%20%C2%B7%20Trivy%20%C2%B7%20OSV--Scanner-blue)](https://github.com/guzmandrade-dev/acp-assist/actions/workflows/security.yml)

**Website:** <https://guzmandrade-dev.github.io/acp-assist/>

**One app, three editors, plus PDF review.** ACP Assist is a single floating
companion app for LyX, LibreOffice, and ONLYOFFICE — pick the editor with the
in-app switcher — with a fourth **PDF Review** mode for discussing a compiled
PDF. The panel reads your document, chats, and writes **directly into
the live editor document**. All reasoning is delegated to an external agent
over the [Agent Client Protocol](https://agentclientprotocol.com/) (ACP);
there is no LLM and no API key inside the app.

| App | Description |
|---|---|
| **[ACP Assist](apps/acp-assist)** | **One installer for all three editors + PDF review** — bundles LyX, LibreOffice, and ONLYOFFICE behind an in-app switcher (one active at a time; per-app, per-document history), plus a PDF Review mode (prose-only chat keyed by the PDF path, structured reports, open-in-viewer) |
| **[LyX ACP Assist](apps/lyx)** | Assistant for [LyX](https://www.lyx.org/) — writes through the LyXServer named pipe and the `application/x-lyx` clipboard format, so LyX itself performs every insertion |
| **[LibreOffice ACP Assist](apps/libreoffice)** | Assistant for [LibreOffice](https://www.libreoffice.org/) — Writer, Calc, and Impress via a small in-process UNO bridge (`.oxt`) with per-module adapters |
| **[ONLYOFFICE ACP Assist](apps/onlyoffice)** | Assistant for [ONLYOFFICE Desktop Editors](https://www.onlyoffice.com/desktop.aspx) — Documents, Spreadsheets, and Presentations via a small in-editor JavaScript plugin (`.plugin`) that connects out to the companion |

Since v1.6.0, releases ship **only the unified ACP Assist installer** (one per
OS, plus the bridge `.oxt` / `.plugin` files for editor-side install). The
per-editor apps remain in the repo as development workspaces.

All three editors share one architecture: the editor stays the **single writer of
truth**, the agent decides intent via a small vocabulary of action tags that
the app executes mechanically, and every edit is one undo step. The panel is
a quiet chat surface that floats beside the document.

Beyond editing, the unified app has a **PDF Review mode** (fourth switcher
entry) — the structured-review loop ported from the archived Visual Research
Pal prototype, minus its PDF viewer. Open a PDF (attach it with **+** or give
a path); the chat is prose-only and keyed by the PDF's path, so the
question → suggestion → repeat loop persists per PDF. **Review…** sends the
page-marked text (pdfjs-dist) plus optional page images and the conversation
history to the agent under a fixed JSON schema (one conversion retry when the
reply is prose); validated suggestions render in the panel — each page number
jumps to that page in the viewer — and can be downloaded as a ZIP containing a
flat, self-contained `report.html` (inline styles, no images/scripts) plus
`report.json`.
**Open in viewer** opens the PDF in the system's default PDF application; when
SumatraPDF is detected on Windows it is used instead, so page jumps work via
`-reuse-instance -page <N>` (the TextMaker-style forward jump). The PDF is
never edited — Undo is replaced by Review in this mode.

## Repository layout

```
packages/core/    @acp-assist/core: shared ACP client, types, attachment
                  conversion, chat-history persistence, restart replay
packages/panel/   @acp-assist/panel: the shared companion panel UI + Electron/
                  standalone shell hosts
apps/acp-assist/  Unified companion: one app, in-app switcher between the
                  three editors and the PDF-review mode (multi-backend host
                  around the same servers)
apps/lyx/         LyX companion (Electron + read-only .lyx parser + pipe client)
apps/libreoffice/  LibreOffice companion (Electron + UNO bridge + module adapters)
apps/onlyoffice/  ONLYOFFICE companion (Electron + in-editor .plugin bridge)
```

npm workspaces: install once at the root (`npm install`), then develop,
test, and package from any app's directory. `@acp-assist/core` rides along
as a regular workspace dependency. CI packages and releases **only the
unified app** (`apps/acp-assist`) — one installer for all three editors plus
PDF review; the per-editor apps remain in the repo for development, testing,
and documentation. See each app's README for requirements and usage.

## Install

Download the **ACP Assist** installer for Windows, macOS, or Linux from the
[Releases](https://github.com/guzmandrade-dev/acp-assist/releases) page
(v1.6.0+). Each release also attaches `acp-bridge.oxt` (LibreOffice) and
`acp-bridge.plugin` (ONLYOFFICE) for installing the editor-side bridge; the
installers bundle copies of both. See [apps/acp-assist](apps/acp-assist) for
how the unified app works.

## Development

Node.js 22+. From an app's directory (use `apps/acp-assist` for normal work):

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
repositories. It also absorbed the structured-review loop of the former
`visual-research-pal` repository (now archived read-only on GitHub).