# Local MemOS server: setup and operations

- **Status (2026-10-23):** installed, and the boot test passed.
- **Blocked on:** cloud LLM and embedding API keys. The add/search and restart check have not run yet.
- **Source:** `MemoryOS==2.0.33`, verified clean (see `docs/memos-provenance-report.md`).

## Layout

| What | Where |
|---|---|
| Runtime root | `/Users/claude/work/memos-runtime` |
| Control script | `/Users/claude/work/memos-runtime/bin/memosctl` (copy: `docs/memos-local/memosctl`) |
| Env file (secrets and config, mode 600) | `/Users/claude/work/memos-runtime/memos.env`; never commit or print it |
| Python venv | `/Users/claude/work/memos-runtime/venv` (lock: `docs/memos-local/requirements.lock.txt`) |
| Graph store | Neo4j Community 5.26.16, data in `data/neo4j` |
| Vector store | Qdrant 1.16.3, data in `data/qdrant` |
| Logs | `logs/memos-api.log`, `logs/qdrant.log`, `logs/neo4j/` |
| Process HOME | `/Users/claude/work/memos-runtime/home` (scratch; no host credential files) |

## Endpoints

All three services listen on 127.0.0.1 only. This was checked with `lsof` after start.

| Service | Address |
|---|---|
| MemOS API | `http://127.0.0.1:8001` |
| Neo4j | bolt `127.0.0.1:7687`, http `127.0.0.1:7474` |
| Qdrant | http `127.0.0.1:6333`, gRPC `127.0.0.1:6334` |

- **Health:** `GET /health`
- **Add memory:** `POST /product/add`
- **Search:** `POST /product/search`
- **Others:** `POST /product/get_all`, `POST /product/get_memory`, `GET /product/get_memory/{memory_id}`, `POST /product/delete_memory`, `POST /product/create_cube`, `POST /product/exist_mem_cube_id`
- **OpenAPI spec:** `GET /openapi.json`

## Scoping primitives

- **`user_id`** (required on add and search): the owner of the memories.
- **`writable_cube_ids`** (add) and **`readable_cube_ids`** (search): memory cubes, the namespace unit. Legacy single `mem_cube_id` is also accepted.
- **`session_id`**: conversation or session grouping inside a cube.
- **`project_id`**, **`manager_user_id`** (add): extra attribution fields.
- **`custom_tags`**, **`info`** (add) and **`filter`** (search): metadata tagging and filtering.

## Commands

```bash
/Users/claude/work/memos-runtime/bin/memosctl start          # neo4j + qdrant + API
/Users/claude/work/memos-runtime/bin/memosctl stop
/Users/claude/work/memos-runtime/bin/memosctl status
/Users/claude/work/memos-runtime/bin/memosctl restart-api    # API only; storage stays up
/Users/claude/work/memos-runtime/bin/memosctl start-storage  # neo4j + qdrant only
```

- `start` refuses to launch the API while `OPENAI_API_KEY`, `MEMRADER_API_KEY` or `MOS_EMBEDDER_API_KEY` is empty in the env file.
- Every process runs under `env -i` with the scratch HOME. The API gets only the variables in `memos.env`.

## Config (`memos.env`)

- **Secrets:**
  - `NEO4J_PASSWORD`: random, generated locally.
  - `OPENAI_API_KEY`, `MEMRADER_API_KEY`, `MOS_EMBEDDER_API_KEY`: blank until the owner fills them.
- **Model defaults:** OpenAI-compatible base `https://api.openai.com/v1`.
  - Chat and memory-reader models: `gpt-4o-mini`.
  - Embeddings: `text-embedding-3-small`, dimension 1536.
  - To use another OpenAI-compatible provider, change the `*_API_BASE` and model lines.
- **Off by default:** chat API, internet search, preference/activation memory and the Redis queue.
- **Not set:** `CUSTOM_LOGGER_URL`, so no remote log shipping.
- **Embedding dimension is fixed.** The Qdrant collection is created with this dimension at first start. If you change `EMBEDDING_DIMENSION` later, wipe `data/qdrant` and `data/neo4j`.

## Not done yet

- **Restart check:** add, then a full restart, then search. Ready to run as `bin/restart-check.sh` (copy in `docs/memos-local/`). It waits for the API keys.
- **launchd:** no LaunchAgent is installed. Persistence is the owner's to install.
