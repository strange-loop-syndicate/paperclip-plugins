# bang-commands — agent rules

- **What:** Paperclip plugin that runs `!<command>` task comments from allowed users and replies with the output. See `README.md`.
- **Language:** TypeScript, bundled by esbuild (`npm run build` → `dist/`). `dist/` is not committed. The live install loads it from a release copy that `scripts/release-install.mjs` builds (root `README.md`).
- **Tests:** `npm test` (vitest). Every behaviour change needs a test.
- **Invariants:**
  - Only users in `ALLOWED_USER_IDS` (`src/commands.ts`) trigger a command. Agent and plugin events never do.
  - Every command has a timeout and its process group is killed on expiry.
  - `!restart-paperclip` replies before it restarts the server.
- **Live server:** the scripts in `scripts/` restart and inspect the live lab server. Do not run them from a task unless the task asks for it.
- **Work:** use a branch and a worktree under `/Users/claude/work/workspace/.worktrees/`. Never commit on `main` directly.
