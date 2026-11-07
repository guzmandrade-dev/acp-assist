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
- Per-app facts and live-verified findings live in each app's
  `AGENTS.md` (`apps/*/AGENTS.md`); those files are the source of truth
  for app behavior.
- `next-steps.md` (repo root) is an untracked session handoff — never
  commit it.
