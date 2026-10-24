# linear-cli — agent rules

- **What:** `linear`, a no-dependency Node CLI that talks to Linear's GraphQL API with the key in env `LINEAR_API_KEY`. `skill/SKILL.md` is the company skill `linear-api` that documents it. See `README.md`.
- **Language:** plain ESM JavaScript (`.mjs`), Node 24+. No `npm install` step; keep it dependency-free.
- **Tests:** `npm run check` (syntax check plus `node --test` with a mocked `fetch`). Every behaviour change needs a test.
- **Invariants:**
  - The key comes only from env `LINEAR_API_KEY`. Never print it, never read `.env` files. Errors scrub it.
  - No delete, archive or issue-create calls. The only mutations are `issueUpdate` (state only), `commentCreate` and `commentResolve`; a test enforces this.
  - Every write re-fetches and prints the written object, and exits 3 if the readback does not show the write.
- **Skill:** when a command or flag changes, update `skill/SKILL.md` in the same PR.
- **Work:** use a branch and a worktree under `/Users/claude/work/workspace/.worktrees/`. Never commit on `main` directly.
