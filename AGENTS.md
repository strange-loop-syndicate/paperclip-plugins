# paperclip-plugins — agent rules

- **Layout:** one folder per plugin, each with its own `package.json`, tests and `AGENTS.md`. Plugins share no code.
- **Work:** use a branch and a worktree under `/Users/claude/work/workspace/.worktrees/`. Never commit on `main` directly; changes land by PR.
- **Tests:** run `npm test` inside the plugin folder you changed, plus any fuller check its own `AGENTS.md` names (for example `npm run check` in `usage-limits/`). For `scripts/`, run `node --test "scripts/test/*.test.mjs"`.
- **Live installs:** never point Paperclip at a working checkout (this repo or a worktree). A write in a watched plugin folder hot-reloads the worker and drops its event subscriptions. Installs and updates go only through `scripts/release-install.mjs`, from merged commits. See `README.md` → "Install and update".
- **Release folders:** never write in or delete anything under `/Users/claude/work/paperclip-plugins-releases/`.
