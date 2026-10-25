# usage-limits — agent rules

- **What:** Paperclip plugin that shows Claude and Codex subscription usage in the sidebar. See `README.md`.
- **Language:** TypeScript and React, bundled by `build.mjs` (`npm run build` → `dist/`). `dist/` is not committed. The live install loads it from a release copy that `scripts/release-install.mjs` builds (root `README.md`). Node 24+.
- **Tests:** `npm run check` (typecheck, `node --test`, build, manifest validation). Every behaviour change needs a test.
- **Invariants:**
  - Read-only: capabilities stay `agents.read` and `ui.sidebar.register`.
  - Never show an old or 0% value for a window whose reset has passed. Show `—`.
  - Run-log scans stay bounded (run count and byte limits in `README.md`).
- **Work:** use a branch and a worktree under `/Users/claude/work/workspace/.worktrees/`. Never commit on `main` directly.
