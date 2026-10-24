# linear-intake — agent rules

- **What:** Paperclip plugin that turns Linear issues delegated to the agent user (state Todo) into `[KEY] …` tasks for the Project Lead, every 2 minutes. See `README.md`.
- **Language:** TypeScript, bundled by `build.mjs` (`npm run build` → `dist/`). The live install loads `dist/`, so rebuild after every source change. Node 24+.
- **Tests:** `npm run check` (typecheck, `node --test`, build, manifest validation). Every behaviour change needs a test.
- **Invariants:**
  - No writes to Linear. The Project Lead owns them.
  - No LLM calls. The task body is the Linear URL only; never copy the Linear description, status or comments.
  - Idempotent by key: no duplicate `[KEY]` task after a restart or a lost state write.
- **Work:** use a branch and a worktree under `/Users/claude/work/workspace/.worktrees/`. Never commit on `main` directly.
