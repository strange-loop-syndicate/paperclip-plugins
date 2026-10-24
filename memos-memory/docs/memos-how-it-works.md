# How MemOS 2.0.33 works: memory kinds, writing, recall and maintenance

- **Scope:** the installed `MemoryOS==2.0.33` API server, with the flags we run today.
- **Basis:** a read of the installed source, plus the SLS-61 restart check. Source refs are in the agent section.

## Short answer

| Question | Answer for our setup |
|---|---|
| Memorizes automatically? | **Only when the client calls `/product/add`.** The chat endpoints auto-add, but they are off. |
| Injects memories automatically? | **No.** `/product/search` returns memories, and the client puts them into its own prompt. |
| Reconciliation (dedup, conflicts, merges)? | **Exists, off by default.** One flag enables it. It runs on background threads and uses LLM calls. |
| Other maintenance | Working-memory cap, feedback corrections, hard delete, and the "Dream" summarizer plugin (beta, off). |

## Memory kinds

Every memory is a node in a graph (Neo4j) with a vector (Qdrant). Each node has a `memory_type`:

- **UserMemory:** facts about the user. Our restart-check marker became one.
- **LongTermMemory:** general facts from conversations and documents.
- **WorkingMemory:** a short list of recent, active items, capped at 20. The oldest drop out first.
- **ToolSchemaMemory / ToolTrajectoryMemory:** how tools were called and what happened. Extraction runs when messages contain tool calls.
- **SkillMemory:** reusable procedures. Extraction runs after 5 or more tool rounds in one exchange.
- **PreferenceMemory:** likes, dislikes and style. **Off** (`ENABLE_PREFERENCE_MEMORY=false`).
- **OuterMemory / RawFileMemory / Context:** internet results, raw file chunks, and Dream summaries. All are off or unused for us.
- **Not in this server:** activation (KV-cache) memory and parametric (LoRA) memory. The API server builds every cube without them.

Each node stores: `key` (title), `memory` (text), `tags`, `background` (LLM context summary), `sources` (the original messages), `confidence`, `status`, `user_id`, `session_id`, and timestamps.

## Writing: what `/product/add` does

- **Input:** chat `messages` (or documents), plus `user_id` and the cube in `writable_cube_ids`.
- **An LLM extracts memories.** The message is rewritten into short, self-contained facts. It is not stored verbatim.
- **Two timing modes:**
  - `async_mode: "async"` (**default**): raw text windows are stored at once with no LLM. A background task then runs the LLM extraction and replaces the raw nodes.
  - `async_mode: "sync"` + `mode: "fine"`: the LLM extracts before the call returns. It is slower and costs one or more LLM calls per add. Use it when the next step reads the memory right away.
- **No merge on add.** Adding the same fact twice gives two nodes. Search dedup (MMR) hides most duplicates at read time.

## Recall: what `/product/search` does

- **Scope:** `user_id` + `readable_cube_ids` (+ an optional `session_id`, which only raises the weight).
- **Steps:** the query is embedded, candidates come from the graph and vector stores, then a reranker scores them, then dedup (MMR) runs and the `top_k` best return.
- **Cut-off:** `relativity` (default **0.45**). Results below it are dropped.
  - In the restart check, a vague query scored 0.33 and returned nothing. A specific query scored 0.48 and returned the memory.
  - **For the plugin:** expose `relativity` and `top_k`, or tune them. The default suits specific queries.
- **Modes:** `fast` (default, no LLM on the query), `fine` (an LLM rewrites the query and fills gaps, so it costs money), and `mixture` (needs Redis, so it falls back to fast here).

## Injection: who puts memories into the prompt

- **Our side does.** The server has no hook that injects memories into another program's prompts.
- `/product/chat/complete` and `/chat/stream` do search, then answer, then auto-add. That is MemOS acting as the chat model. They return 503 unless `ENABLE_CHAT_API=true`, and we keep it off.
- **For the SLS-60 plugin:** before a run, call search and add the results to the agent context. After a run, call add with the useful messages.

## Reconciliation and maintenance

- **Conflict and duplicate resolution** (`MOS_ENABLE_REORGANIZE=true`, off now):
  - Background threads find similar memory pairs (similarity ≥ 0.8). An LLM labels each pair as contradictory, redundant or independent.
  - Contradictory and redundant pairs merge into one new node. Both originals are archived.
  - **Risk:** if the LLM cannot resolve a pair, the code **hard-deletes the older node**.
  - Every 100 s it also re-clusters the graph and adds summary nodes and relation links (cause, condition, conflict).
  - **Cost:** it makes LLM calls continuously while it runs.
- **Feedback corrections:** `POST /product/feedback` (or add with `is_feedback=true`). An LLM reads the correction and then adds, updates or archives memories. This is the only update path: there is no "edit memory" endpoint.
- **Working-memory cap:** 20 items (`MOS_WORKING_MEMORY`). The oldest are removed when it overflows.
- **Delete:** `POST /product/delete_memory` by IDs or filter, a hard delete. Archive and soft-delete states exist but are used only on internal paths.
- **Versioning:** `version`, `history` and `evolve_to` fields exist. They stay unused unless `MEM_READER_MEM_VERSION_SWITCH=on`, and no built-in code fills them.
- **Dream plugin (beta, off):** after 100 adds it writes context summaries, "insights" and diary entries. Enable it with `MEMOS_ENABLED_PLUGINS=dream`.
- **Scheduler:** always on in the API server, as an in-process queue with no Redis. It runs the async extraction and the feedback tasks.

## Recommendations for SLS-60 (Paperclip memory plugin)

1. **The plugin does both injection and memorizing:** search before a run, add after it.
2. **Add with `async` by default.** Use `sync` + `fine` only when a memory must be readable at once.
3. **Keep reorganize off at first.** It deletes data when the LLM fails and makes LLM calls continuously. Turn it on only after a snapshot and a test cube.
4. **Map scope:** one `user_id` per company or agent, and one cube per project or agent. `session_id` = the Paperclip run or task.

---

<details>
<summary>🤖 For agents: source references (site-packages/memos/, v2.0.33)</summary>

- Memory types enum: `memories/textual/item.py:178-189`. Node fields: `item.py:109-160, 190-214`.
- Cube built without act/para memory: `api/handlers/component_init.py:251-255`. Tree text always on: `api/config.py:1077`.
- Preference gate: `mem_reader/read_pref_memory/process_preference_memory.py:272`. Tool extraction trigger: `mem_reader/multi_modal_struct.py:922-944`. Skill ≥5 rounds: `mem_reader/read_skill_memory/process_skill_memory.py:1025-1027`.
- Add defaults (async default, mode only in sync): `api/product_models.py:642-659, 768-773`. Async uses fast: `multi_mem_cube/single_cube.py:686-689`. Raw-to-LLM replace: `mem_scheduler/task_schedule_modules/handlers/mem_read_handler.py:172-198, 401-413`. Fine extraction passes: `multi_modal_struct.py:1020-1059`. Merge on add is a no-op: `multi_modal_struct.py:542-564`.
- Chat auto-add + gate: `api/handlers/chat_handler.py:140-175, 207-220`; `api/routers/server_router.py:82-93, 278-281`.
- Search: relativity default `product_models.py:406-414`; threshold applied `api/handlers/search_handler.py:254-280`; MMR `search_handler.py:91-116`; reranker default `http_bge` at localhost:8000 `config.py:584-605`; zero-score fallback `reranker/http_bge.py:129-131`; WorkingMemory recall `recall.py:122-131`; LTM/User recall `searcher.py:733-825`; mixture needs Redis `optimized_scheduler.py:129-143`.
- Reorganizer: flag `config.py:1336`; threads `organize/reorganizer.py:96-106, 158-171`; conflict/merge `organize/handler.py:23, 30-74, 131-187`; relations `organize/relation_reason_detector.py:58-79, 232`.
- Working memory cap: `config.py:1340`; eviction `organize/manager.py:250-261, 527-547`.
- Scheduler always on unless `API_SCHEDULER_ON=false`: `component_init.py:283-313` (`MOS_ENABLE_SCHEDULER` only affects legacy configs, `config.py:972-974`).
- Feedback: `mem_feedback/feedback.py:269-335`; `api/handlers/add_handler.py:72-105`. Version switch: `config.py:1074`; soft delete path `tree.py:621-649`. Dream: `dream/plugin.py:48, 67-71`; `dream/signal_store.py:16`.
- Live observation 2026-10-23: no listener on 127.0.0.1:8000, yet rerank=true returned 0.33/0.48 and rerank=false returned 0.0. So the reranker set in `memos.env` scores for real; it is not the BGE zero fallback. Scheduler queue was empty after the restart (`/product/scheduler/allstatus`).

</details>
