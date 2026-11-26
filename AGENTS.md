# ACP Assist — repo working rules

Monorepo: `apps/lyx` + `apps/libreoffice` + `apps/onlyoffice` +
`apps/acp-assist` over npm workspaces, shared code in `packages/core`
(`@acp-assist/core`) and `packages/panel` (`@acp-assist/panel`).

- Do not commit or open PRs without explicit user approval; do not create
  worktrees; work on the user's local branch. Finish tasks with changes
  ready to commit.
- **Commit per task, not per session.** Split a working-tree change into
  one commit per logical unit — a feature, a fix, its tests, its docs —
  so `git log` and blame stay useful for reference. Group only what is
  truly inseparable (e.g. a source change and the tests that cover it).
  Never bundle unrelated cleanup into a fix.
- `next-steps.md` (repo root) is an untracked session handoff — never
  commit it.

## AGENTS.md convention

- This root `AGENTS.md` holds repo-wide rules (the ones above).
- Each `apps/*/AGENTS.md` holds that app's live-verified findings
  (pipe/bridge/UNO/plugin rules, pitfalls, probe results) — the source
  of truth for app behavior. Keep them per app: every `AGENTS.md` on
  the path from a file up to the repo root is active, and the one
  closest to the file wins on conflict, so working under `apps/lyx/`
  automatically loads the LyX findings without stuffing them into the
  root file. Do not merge them into the root; move only genuinely
  shared rules up.
- Repository layout (what lives in `packages/` vs `apps/`) is
  documented in the root `README.md` — keep it in sync with moves.

## Release process (recorded 2026-11-26, after v1.15.0)

Releases are tag-driven; CI does the building. Steps:

1. `main` green (`npm test` + `npm run typecheck` at the root) and the
   working tree committed — one commit per logical unit (see above);
   never commit `next-steps.md`.
2. Bump the version in ALL of: root `package.json`,
   `apps/acp-assist/package.json`, and every `"version": "X.Y.Z"` line in
   `package-lock.json` (three spots: root entry plus the
   `acp-assist` / `acp-assist-unified` workspace entries).
3. Commit `chore: Bump version to X.Y.Z` (plain message — the commit-msg
   hook strips any Mistral trailer lines, do not add them).
4. Annotated tag on the bump commit: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
5. Push (ask first; one push per branch per session unless pre-authorized):
   `git push origin main` then `git push origin vX.Y.Z`.
6. `.github/workflows/build.yml` fires on `v*` tag pushes
   (`permissions: contents: write`): a `test` matrix (lyx + libreoffice on
   ubuntu + windows: `npm ci`, `npm test`, `npm run typecheck`), an
   `assets` job rebuilding the LO bridge .oxt and ONLYOFFICE .plugin, a
   3-OS `build` matrix packaging ONLY the unified app (`apps/acp-assist`)
   per OS (nsis/portable/zip on Windows, dmg/zip on macOS, AppImage/deb/
   tar.gz on Linux; icons regenerated on the Windows runner), and a
   `release` job that publishes a DRAFT GitHub Release
   (`softprops/action-gh-release`, `draft: false` (published directly so the in-app updater's `releases/latest` check can see them), generated notes) with
   all artifacts incl. the bridge .oxt/.plugin. Verify on GitHub after the
   tag push; the workflow run is the gate.

## Local leftovers

- `state/` was an empty runtime leftover dir; it is removed and
  git-ignored. `.worktrees/` may hold linked worktrees of OTHER repos
  — never delete or commit it.
