# paperclip-plugins — agent rules

- **Layout:** one folder per plugin, each with its own `package.json`, tests and `AGENTS.md`. Plugins share no code.
- **Work:** use a branch and a worktree under `/Users/claude/work/workspace/.worktrees/`. Never commit on `main` directly; changes land by PR.
- **Tests:** run `npm test` inside the plugin folder you changed, plus any fuller check its own `AGENTS.md` names (for example `npm run check` in `usage-limits/`).
