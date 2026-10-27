# SLS-200: memories that hold after the task closes

## What changed
- **Extractor keeps durable knowledge only:** lessons, decisions that set a rule, lasting facts about systems, and outcomes a later task can reuse. Task status, task logs and IDs are dropped. Most comments now give an empty list.
- **`outcome` means a reusable result:** a measured limit, or an approach proven to work or to fail. "Merged", "deployed", "accepted" and "tests pass" are not outcomes. The Jev outcome question asks the same.
- **Code check after the extractor** (`src/noise.js`): drops commit hashes, run and card IDs, PR numbers, test counts, exit codes, task-status words, per-task outcomes, this company's task IDs and leftover redaction labels.
- **Duplicate search before each add:** best hit in the same scope at cosine 0.85 or more → not stored, logged as `duplicate`.
- **Paths kept intact:** paths, URLs, emails and IP addresses go to the extract model as placeholders and come back as written.
- **Dry-run route** for the clean-up list and the replay measure. It stores nothing.

## Where `[PERSON_NAME]` came from
- **Not MemOS.** A probe add of `/Users/claude/work/memos-runtime … Oleg` to the probe company cube came back unchanged. MemOS 2.0.33 has no personal-data filter in its code.
- **The OpenRouter extract call.** The 2026-10-24 shadow log holds the extractor's answer before any MemOS call, and it already shows `/Users/[PERSON_NAME]/`. It also turned the name `Oleg` into `[PERSON_NAME]`.
- **Fix:** placeholders around the call. Names are not paths, so `protectTerms` lets an operator protect a user name too. A memory that still holds a redaction label is dropped (`redacted`).

## Duplicate threshold: 0.85, not 0.88
- **On the Ops cube (666 memories), the same fact in other words scored 0.83–0.88.** Examples: the "agents never set `done`" rule at 0.834, the MemOS fine-search result at 0.857, the checkout rule at 0.869.
- **Different facts start below 0.83.** At 0.80–0.83 most pairs were related but distinct.
- **`dupSimilarity` is a setting.** The search score is MemOS `relativity`. An exact copy scores 1.0, so it behaves as a cosine.

## Run the clean-up list (step 4)
1. `node e2e/cleanup-plan.mjs dump http://127.0.0.1:8001 <companyId> dump.json <projectId>… unscoped`
2. `node e2e/cleanup-plan.mjs batches dump.json batches --path-user claude`
3. POST each `batches/batch-NNN.json` to the dry-run route. Save each answer as `results/result-NNN.json`.
4. `node e2e/cleanup-plan.mjs report dump.json results plan.md --projects projects.json`

The script reads MemOS and writes files. It deletes nothing.

## Run the replay measure (step 5)
1. Save the verdict log for each day of the window (`shadow-log` route) as `log-YYYY-MM-DD.json`.
2. `node e2e/replay-window.mjs batches <logDir> <fromIso> <toIso> batches`
3. POST each batch to the dry-run route (no `dupCheck`). Save the answers as `results/result-NNN.json`.
4. `node e2e/replay-window.mjs dedup http://127.0.0.1:8001 results dedup.json`: the duplicate check in comment order, on a new probe-company cube. No real cube is touched.
5. `node e2e/replay-window.mjs report results dedup.json report.md`: counts and a seeded sample of 30 to grade.

<details>
<summary>🤖 For agents: calibration data (can be skipped)</summary>

**Code check on the SLS-199 graded sample** (`sample70.txt`, grades from the SLS-199 review; old extractor output):

| Grade | Dropped, task-ID rule off | Dropped, task-ID rule on |
|---|---|---|
| Durable (30) | 3 | 9 |
| Task log (25) | 11 | 21 |
| Stale (15) | 13 | 14 |

- The task-ID rule costs 6 durable memories here because the old extractor named the task in almost every memory. The new prompt does not send the task ID, so it applies to new captures only. The clean-up re-judge runs without it.
- Durable memories the check drops: two name a release commit for a rollback, one names a PR number.

**Clean-up, code check only** (no LLM; a floor, before the deploy): 811 memories → 488 keep, 308 delete, 15 merge.

</details>
