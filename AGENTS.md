# paperclip-plugins — agent rules

- **Layout:** one folder per plugin, each with its own `package.json`, tests and `AGENTS.md`. Plugins share no code.
- **Work:** use a branch and a worktree under `/Users/claude/work/workspace/.worktrees/`. Never commit on `main` directly; changes land by PR.
- **Tests:** run `npm test` inside the plugin folder you changed, plus any fuller check its own `AGENTS.md` names (for example `npm run check` in `usage-limits/`). For `scripts/`, run `node --test "scripts/test/*.test.mjs"`.
- **Live installs:** never point Paperclip at a working checkout (this repo or a worktree). A write in a watched plugin folder hot-reloads the worker and drops its event subscriptions. Installs and updates go only through `scripts/release-install.mjs`, from merged commits. See `README.md` → "Install and update".
- **Release folders:** never write in or delete a `<plugin>/<sha>/` folder under `/Users/claude/work/paperclip-plugins-releases/`. Only the script writes there: new release folders and its `_installs/` records.
- **First switch (SLS-143):** run the script from a fresh worktree or clone at `origin/main`, never after a `git pull` in `/Users/claude/work/paperclip-plugins-repo`. A pull there reloads the live plugins. See `README.md` → "Run it".
- **Restart after the first switch:** after a plugin first moves from a checkout path to a release copy, restart the Paperclip server once, before any build, `npm install` or `git pull` in that checkout. API installs do not move the dev watcher. Copy-to-copy switches need no restart.
