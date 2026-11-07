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

## Local leftovers

- `state/` was an empty runtime leftover dir; it is removed and
  git-ignored. `.worktrees/` may hold linked worktrees of OTHER repos
  — never delete or commit it.
