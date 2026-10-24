# memos-memory — agent rules

- **What:** Paperclip memory plugin backed by MemOS (`src/plugin.js`, capture in `src/capture.js`), its sharing settings page (`ui/index.js`), and the pre-prompt recall wrapper for the `claude_local` / `codex_local` adapters (`src/wrapper/`, `bin/`). See `SETUP.md`.
- **Language:** plain ESM JavaScript, Node 20+. No build step, also for the UI (`React.createElement`, no JSX). Only `@paperclipai/plugin-sdk` as a dependency. The wrapper must stay dependency-free.
- **Tests:** `npm test`. They use a fake MemOS server and need no live services. Every behaviour change needs a test. Break the code once to check that the test catches it.
- **Invariants:**
  - Never read across companies.
  - Sharing is opt-in only, set on the settings page by a board user.
  - Raw comment text is never stored in MemOS or plugin state. Only extracted memories and IDs are.
  - Capture defaults to shadow mode. Turning on `save` is a board decision.
  - Every MemOS and OpenRouter call has a timeout and fails open. Failed captures wait in the retry queue, never in the task.
  - The wrapper must never block or change a run when recall fails.
- **Live config:** do not change live Paperclip agents' adapter config from this repo's tasks. That belongs to the E2E task.
- **Work:** use a branch and a worktree under `/Users/claude/work/workspace/.worktrees/`. Never commit on `main` directly.
