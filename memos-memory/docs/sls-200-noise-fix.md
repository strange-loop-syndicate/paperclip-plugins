# SLS-200: memories that hold after the task closes

## What changed
- **Extractor keeps durable knowledge only:** lessons, decisions that set a rule, lasting facts about systems, and outcomes a later task can reuse. Task status, task logs and IDs are dropped. Most comments now give an empty list.
- **`outcome` means a reusable result:** a measured limit, or an approach proven to work or to fail. "Merged", "deployed", "accepted" and "tests pass" are not outcomes. The Jev outcome question asks the same.
- **Code check after the extractor** (`src/noise.js`): drops commit hashes, run and card IDs, PR numbers, test counts, exit codes, task-status words, per-task outcomes, this company's task IDs and leftover redaction labels.
- **Company process rules dropped (0.3.3, SLS-208):** the extractor and the code check drop chain of command, cards, review and approval routes, task closure and who merges. Agents get these from `AGENTS.md`. The code check needs a company role and a process word in one clause, at most 4 words apart, or a card with a task status or a role in a memory that does not name Paperclip. On the round 3 replay set it drops 22 of 338 memories, among them both stale rules of the sample. A window of 2 drops 18, 3 drops 20, 5 drops 22.
- **Stricter judge (0.3.3):** the same rule plus a small detail is a duplicate. Another system, condition or reason is still new.
- **Judge asks for no reasoning (0.3.4, SLS-211):** in round 4, 4 of 87 judge calls ended at the 400-token cap with no text or 6 characters, so each repeat was kept. The judge now sends `reasoning.effort: "none"`, and a reply with no verdict logs its token use.
- **Duplicate search before each add:** best hit in the same scope at cosine 0.85 or more → not stored, logged as `duplicate`.
- **Paths kept intact:** paths, URLs, emails and IP addresses go to the extract model as placeholders and come back as written.
- **Dry-run route** for the clean-up list and the replay measure. It stores nothing.

## Where `[PERSON_NAME]` came from
- **Not MemOS.** A probe add of `/Users/claude/work/memos-runtime … Oleg` to the probe company cube came back unchanged. MemOS 2.0.33 has no personal-data filter in its code.
- **The OpenRouter extract call.** The 2026-10-24 shadow log holds the extractor's answer before any MemOS call, and it already shows `/Users/[PERSON_NAME]/`. It also turned the name `Oleg` into `[PERSON_NAME]`.
- **Fix:** placeholders around the call. Names are not paths, so `protectTerms` lets an operator protect a user name too. A memory that still holds a redaction label is dropped (`redacted`).
- **Deploy setting:** set `protectTerms` to at least `["Oleg"]`. Without it, a memory that names him comes back as `[PERSON_NAME]` and is dropped.

## Duplicate judge: cosine alone cannot reach 3%
- **In the 0.3.0 replay, paraphrases and distinct facts on one topic both scored 0.70–0.80.** At `dupSimilarity` 0.80, 40 of 318 kept memories still restated an older one (27 nearly word for word). The 38 distinct pairs in the same band would be lost by a lower cut-off.
- **So hits from 0.70 to the threshold go to a judge:** one short call to the extract model, "same fact or not", with the top 3 hits. A failed call stores the memory.

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
   - **This writes to MemOS:** the cube `paperclip-e2e-probe-company-sls200-replay-<ms>` stays after the run. Its name is in `dedup.json` (`scope`) and goes in the step 5 report.
5. `node e2e/replay-window.mjs report results dedup.json report.md`: counts and a seeded sample of 30 to grade.

**With the duplicate judge (0.3.1),** steps 4 and 5 become:
1. `node e2e/replay-window.mjs embed http://127.0.0.1:8001 results state.json`: adds every memory that passed the rules to a new probe-company cube, 6 at a time. The cube name is in `state.json`.
2. `node e2e/replay-window.mjs judge-batches state.json judge --at 0.80 --floor 0.70`: the cosine check against every older memory. The rest, with older hits from 0.70 up, become `duplicates` bodies for the dry-run route.
3. POST each `judge/batch-NNN.json` to the dry-run route. Save the answers as `judge/result-NNN.json`.
4. `node e2e/replay-window.mjs final state.json judge report.md --seed <n>`: counts, a seeded sample of 30, and every kept pair from 0.70 up, to judge by hand.

<details>
<summary>🤖 For agents: calibration data (can be skipped)</summary>

**Code check on the SLS-199 graded sample** (`sample70.txt`, grades from the SLS-199 review; old extractor output):

| Grade | Dropped, task-ID rule off | Dropped, task-ID rule on |
|---|---|---|
| Durable (30) | 3 | 9 |
| Task log (25) | 11 | 21 |
| Stale (15) | 9 | 14 |

- The task-ID rule costs 6 durable memories here because the old extractor named the task in almost every memory. The new prompt does not send the task ID, so it applies to new captures only. The clean-up re-judge runs without it.
- Durable memories the check drops: two name a release commit for a rollback, one names a PR number.
- **Rules kept narrow on purpose.** "still", "currently" and "not yet" count only next to a status word. Outcomes count only in the past or perfect tense. "A PR is merged only by …" and "… still passes" are rules and lessons, so the check must not drop them. The extractor prompt carries the rest of the stale cases.

**Clean-up, code check only** (no LLM; a floor, before the deploy): 811 memories → 529 keep, 265 delete, 17 merge. 20 of the deletes are `redacted`: a name became `[PERSON_NAME]`, which `--path-user` cannot restore.

</details>
