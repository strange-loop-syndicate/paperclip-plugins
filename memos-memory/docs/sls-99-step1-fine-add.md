# SLS-99 Step 1 — does sync `fine` add keep our IDs?

**From:** Engineer (Claude) · **To:** Project Director · **Task:** SLS-99 · **Date:** 2026-10-24

## Answer
- **IDs survive.** Every memory MemReader extracted kept `companyId`, `projectId`, `issueId`, `runId`, `commentId`, `agentId` and `kind`.
- **Pick: path B** (plugin extracts with one Haiku call, then sync `fast` add). Reasons below.

## Why B, although IDs survive

| Need | A: MemOS `fine` | B: plugin call + `fast` |
|---|---|---|
| Keeps our IDs | Yes | Yes (already proven in SLS-63) |
| Short, one sentence | No: 130–245 chars, each starts "On October 24, 2026 at 12:22 PM UTC, the assistant reported that…" | Yes: our prompt sets the form |
| Drops routine status | No: "tests pass, moving to review" and "next I open the PR" were saved | Yes: the prompt drops it |
| Type per memory | No: all memories of one item share the `info.kind` we send | Yes: the call labels each memory |
| Dedup on a repeat add | No: the same comment added twice made 7 memories | Yes: our content-hash dedup still works |
| Time per add | 9.3–13.2 s, inside the event handler | One model call (seconds) + `fast` add (~1 s) |

- **The plan table** picks by ID survival only. The other rows are the plan's own "both paths" rules (short, a few per item, no routine status). Path A fails them.
- **Reversible:** path A is a later swap of one module if MemOS's reader prompt gets tuned.

## Other checks
- **`info` as a search filter:** works. `filter: {and: [{runId}]}` returns the memory; a wrong `runId` returns 0.
- **`custom_tags`:** kept in `metadata.tags` and filterable with `{tags: {contains: …}}`. MemReader adds its own tags too.
- **Where IDs come back:** top-level in search `metadata`, not under `metadata.info`. The current parser already reads both.
- **`info.source`:** comes back `null` (MemOS uses `source` itself). Do not rely on it.
- **Memory types:** MemReader set `LongTermMemory` for the decision and lesson, `UserMemory` for status lines, `type: fact` on all.
- **Cost:** MemOS does not report it per add. Not measured.

---

🤖 **For agents** — evidence below; humans can skip.

- Probe: `memos-memory/e2e/probe-fine.mjs`, run `node e2e/probe-fine.mjs http://127.0.0.1:8001 fine1761` on 2026-10-24 against MemOS 2.0.33 at `127.0.0.1:8001`, probe company `e2e-probe-company`, cube `paperclip-e2e-probe-company-e2e-fine-fine1761`.
- Input: one assistant message with a decision, a lesson, a status line and a next-step line. `async_mode: "sync"`, `mode: "fine"`, `custom_tags: ["paperclip", "kind:decision"]`, `info` with all IDs.
- First add: 13 207 ms, 3 memories (decision 244 chars, lesson ~180 chars, status+next step as one `UserMemory`).
- Repeat add of the same body: 9 295 ms, 4 more memories, no dedup.
- Per-memory ID check (filtered search on `runId`): lesson and all three `UserMemory` items carry `runId`, `companyId`, `commentId`.
- Raw output: `.test-output/step1-probe.json`, `.test-output/step1-probe-ids.txt` in the SLS-99 checkout (not committed).
