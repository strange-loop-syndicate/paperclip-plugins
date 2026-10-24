# Setup

This package has two parts. They work independently.

| Part | What it does | Where it runs |
|---|---|---|
| **Recall wrapper** (`bin/claude/claude`, `bin/codex/codex`) | Recalls memories **before** the agent CLI receives its prompt | As the adapter `command` |
| **Plugin** (`src/worker.js`) | Captures decisions, lessons and task outcomes. Adds the `memory_recall` and `memory_retain` tools | As a Paperclip plugin worker |

## Why a wrapper, not a plugin hook

- **Paperclip 2026.1012.0 has no pre-prompt plugin hook.** `agent.run.started` is published fire-and-forget after the run is `running` (`server/dist/services/heartbeat.js`, `publishRunLifecyclePluginEventData`). The adapter does not wait for it.
- **The adapters honour `config.command`.** The wrapper reads the prompt from stdin and recalls with a hard deadline. Then it injects the memory block and starts the real CLI.
- **The ordering is tested.** `test/wrapper.test.js` checks that the MemOS search response came before the CLI process started.

## Requirements

- Node.js 20.3 or later on the adapter's `PATH`. The wrappers use `#!/usr/bin/env node`. If `node` is missing there, the adapter cannot start the wrapper and the run fails. Check this before you switch an agent over.
- A MemOS server that serves the product API (`POST /product/search`, `POST /product/add`). [SLS-61](/SLS/issues/SLS-61) sets it up.
- `npm install` in this folder, for the plugin only. The wrapper needs no dependencies.

## 1. Install the plugin

1. Install it from this folder as a local-path plugin. The manifest is `src/manifest.js` and the worker is `src/worker.js`. Local-path installs are a development workflow. For a deployed setup, publish the package to npm and install it from there.
2. Set the plugin config:

| Key | Default | Meaning |
|---|---|---|
| `memosBaseUrl` | — | MemOS base URL, for example `http://127.0.0.1:8001`. If it is empty, the plugin does nothing |
| `memosApiKeyRef` | — | Optional Paperclip secret reference for a MemOS bearer token |
| `recallTimeoutMs` | `3000` | Deadline for `memory_recall`, across all scopes |
| `captureTimeoutMs` | `5000` | Timeout for each MemOS write |
| `topK` | `8` | Maximum number of memories returned |
| `captureComments` | `true` | Capture labelled lines from agent comments |
| `captureRunOutcomes` | `true` | Capture one outcome for each succeeded run |
| `sharedScopes` | `[]` | Sharing allowlist. See [Sharing](#4-turn-on-sharing-opt-in) |
| `captureProjectIds` | `[]` | Capture allowlist. If set, comments, run outcomes and `memory_retain` are stored only for these project IDs. Empty stores for every project |

**Plugin config is per company.** `POST /api/plugins/:id/config` needs a `companyId`, and the config applies to that company only. With an empty `captureProjectIds`, every agent comment marker in every project of that company is stored. The MemOS embedder sends each stored line to its embedding API (OpenAI by default). Set `captureProjectIds` for a trial.

**Capabilities requested:** `events.subscribe`, `agent.tools.register`, `plugin.state.read`, `plugin.state.write`, `issues.read`, `issue.comments.read`, `secrets.read-ref`.

**MemOS calls use the worker's own `fetch`, not `ctx.http.fetch`.** The host fetch refuses loopback and private addresses, where self-hosted MemOS lives. It also drops the abort signal, so timeouts would not hold. The MemOS URL is operator config, not agent input.

## 2. Configure the claude_local adapter

Apply this in the E2E task, not here.

```json
{
  "engine": "cli",
  "command": "/Users/claude/work/workspace/paperclip-memos/bin/claude/claude",
  "env": {
    "MEMOS_BASE_URL": "http://127.0.0.1:8001",
    "MEMOS_REAL_COMMAND": "/opt/homebrew/bin/claude"
  }
}
```

- **Set `engine: "cli"`.** New agents default to the ACP engine. ACP starts `claude-agent-acp` and ignores `command`, so the wrapper never runs and nothing is recalled. This applies to Codex (`codex-acp`) too.
- **Keep the file name `claude`.** The adapter compares the command's base name with `claude` before it probes the CLI version and `--effort` support.
- **Placement:** the memory block goes in front of the stdin prompt, for fresh and resumed sessions. The adapter's args and its `--append-system-prompt-file` are not changed. See [Why the user prompt](#why-the-user-prompt-not-the-system-prompt).

## 3. Configure the codex_local adapter

```json
{
  "engine": "cli",
  "command": "/Users/claude/work/workspace/paperclip-memos/bin/codex/codex",
  "env": {
    "MEMOS_BASE_URL": "http://127.0.0.1:8001",
    "MEMOS_REAL_COMMAND": "/opt/homebrew/bin/codex"
  }
}
```

- **Placement:** the memory block goes in front of the stdin prompt, as for Claude. Paperclip's Codex instructions are already part of that prompt.

### Why the user prompt, not the system prompt

The task design named `--append-system-prompt` as one candidate. The wrapper uses the stdin prompt for both CLIs instead:

- **Stored injection gets no extra weight.** Memories are agent-written text. In Claude's system prompt, a bad `Decision: …` line would gain system authority in every later fresh session of the project.
- **Same behaviour for Claude and Codex.** Codex has no system-prompt flag in the adapter path, so only the stdin placement is the same for both.
- **Simpler and cache-friendly.** No temporary prompt files, no cleanup or sweep, and the system prompt stays the same between runs.

## Wrapper environment keys

Set them in the adapter's `env` config. The adapter sets the `PAPERCLIP_*` keys itself.

| Key | Default | Meaning |
|---|---|---|
| `MEMOS_BASE_URL` | — | MemOS base URL. If it is empty, the wrapper skips recall |
| `MEMOS_API_KEY` | — | Optional MemOS bearer token. Use a Paperclip secret binding, not plain text |
| `MEMOS_RECALL_TIMEOUT_MS` | `3000` | Hard deadline, counted from wrapper start, for the issue lookup and all searches together. Values above 3000 are capped at 3000 |
| `MEMOS_TOP_K` | `8` | Maximum number of memories injected |
| `MEMOS_MAX_BLOCK_CHARS` | `4000` | Size cap for the injected block |
| `MEMOS_SHARED_SCOPES` | — | Sharing allowlist as JSON. Use the same shape as the plugin's `sharedScopes` |
| `MEMOS_REAL_COMMAND` | first `claude` / `codex` on `PATH` that is not the wrapper | The real CLI |
| `MEMOS_RECALL_DISABLED` | — | `1` turns recall off. The wrapper then only passes the call through |
| `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_TASK_ID` | set by the adapter | The run's scope. The wrapper reads the issue for its project, title and description |

## Scope and isolation

- **Default scope: company + project.** Each company maps to its own MemOS user (`paperclip-<companyId>`) and each project to its own cube (`paperclip-<companyId>-<projectId>`). Issues without a project use the project key `unscoped`.
- **No cross-company reads.** Every recall builds scopes from the run's own company ID. Allowlist entries for another company are ignored. Results whose metadata names another company or another MemOS user are dropped. Issues from another company are ignored, even if the host returns one.
- **Tools trust the run context's project.** The host takes `runContext.projectId` from the tool request and checks only that the project is in the same company. So `memory_recall` cannot read another company, but a caller could name another project of its own company. `memory_retain` always writes to the run context's project, and refuses an `issueId` from a different project.
- **The agent CLI does not get the MemOS settings.** The wrapper removes every `MEMOS_*` key from the CLI's environment.
- **Remaining risk: MemOS has no per-company auth.** Our checks bind this code, not an agent with a shell. If an agent can reach the MemOS URL, it can query any company's scope by its ID. **Before production,** make MemOS reachable only by the Paperclip host user, not by agent processes. A firewall rule, a socket only that user can open, or a proxy that derives the scope from the run JWT would all work. This belongs to [SLS-61](/SLS/issues/SLS-61) and the E2E task.

## 4. Turn on sharing (opt-in)

Sharing is off by default. Each allowlist entry makes one project scope readable by more readers **in the same company**:

```json
[
  { "companyId": "<company>", "projectId": "<shared-project>" },
  { "companyId": "<company>", "projectId": "<ops-project>", "readerProjectIds": ["<web-project>"], "readerAgentIds": ["<agent-id>"] }
]
```

- **No reader lists:** every agent in that company can read the scope.
- **`readerProjectIds` / `readerAgentIds`:** only runs whose project or agent is listed can read it.
- **Where to set it:** in the plugin's `sharedScopes` for the tools, and in `MEMOS_SHARED_SCOPES` for the wrapper. Use the same value in both places.
- **Writes never move:** captures always go to the run's own company + project scope.

## What gets captured

- **Agent comments** (`issue.comment.created` from an agent): only labelled lines, for example `Decision: …`, `**Lesson:** …`, `Root cause: …`, `Outcome: …`. Text inside code fences and quoted (`>`) lines is ignored. User comments are never captured.
- **Succeeded runs** (`agent.run.finished`): one task outcome. It holds the issue identifier, title and status, and the first paragraph of the run's newest agent comment on that issue (sorted by time, whatever order the host returns).
- **Metadata on every memory:** `companyId`, `projectId`, `agentId`, `issueId`, `issueIdentifier`, `runId`, `kind`, `contentHash`, `source`.
- **Markers need a separator:** `Decision: x` or `Decision - x`. `Decision pending …` and `Decision-making …` are not memories.
- **Dedup:** sha256 of the normalized text (NFKC, lower case, paired markdown emphasis removed, collapsed spaces, no trailing punctuation), for each company + project scope. Lone `_` and `~` stay, so `MAX_RETRIES` and `~/.config` keep their meaning. Run outcomes are checked by content hash **and** by run ID: identical outcomes from different runs are stored once, and a redelivered event stays idempotent even if the issue status changed. Keys live in plugin state (`company` scope, namespace `memos-dedup`). An in-process lock covers concurrent redelivery.

## Failure behaviour

| Failure | Wrapper | Plugin |
|---|---|---|
| MemOS down, 5xx, error code, or slow | Starts the CLI with the original args and prompt, and logs one `[paperclip-memos]` line to stderr after the CLI exits | Recall returns empty, capture logs a warning. The dedup key is not written, so a later delivery retries |
| Paperclip issue lookup fails | Same as above | — |
| Wrapper error | Starts the CLI unchanged | Handler errors are caught and logged |
| `fetch` ignores the abort signal | Deadline still holds: every await races the abort | Same |

**Wrapper process behaviour:**
- **Exit status:** the wrapper exits with the CLI's code. A CLI killed by a signal gives that signal, or `128+n` for signals Node ignores.
- **Stderr order:** the wrapper holds its own lines and writes them after the CLI exits. Both adapters report the first stderr line as the run error, so a login, quota or model error from the CLI stays the reported cause.
- **Signals:** Paperclip signals the whole process group, so the CLI gets each signal once, directly. As group leader the wrapper never forwards. Started any other way (for example from a shell), it forwards at once. It checks the group with `/bin/ps`, in parallel with recall, and logs a warning if it cannot tell.
- **Pass-through:** nested calls skip recall. A call counts as nested when its direct parent is a wrapper, marked by `PAPERCLIP_MEMOS_WRAPPED=<pid>:<depth>`. Interactive use (TTY stdin) also skips recall. A real command that resolves to the wrapper itself exits 127, and so does nesting deeper than 3.

Capture runs on events that the host publishes fire-and-forget. A capture can never fail or delay a run.

## Run the tests

```bash
npm install
npm test
```

## Known limits

- **Checked against live MemOS 2.0.33 in [SLS-63](/SLS/issues/SLS-63).** The mapping (`user_id`, `mem_cube_id`, `memory_content`, `info`, `top_k`) works, and users and cubes need no setup before the first write. Search echoes the add-time `info` keys in `metadata`. A search of another project's or company's cube returns nothing.
- **Adds are sync + fast.** The default async add stores the text, then an LLM rewrites it in the background. The rewritten memory loses `info`, so it has no company, issue or run. Sync + fast stores the text as given with its `info`, makes no LLM call, and takes about 1.3 s.
- **The company filter fails closed.** Recall keeps only results whose `metadata.companyId` is the run's company. A memory written by another client without `info.companyId` is never recalled.
- **Extraction is marker-based (v1).** Unlabelled insights are not captured. Agents can call `memory_retain` for those.
- **Double signals outside Paperclip.** Started by a non-job-control `sh -c` under a terminal, the wrapper is not group leader but shares the group with the CLI. Ctrl-C then reaches the CLI twice, and Claude treats that as "exit now". Paperclip spawns the wrapper as group leader, so this does not happen there.
- **Resumed sessions repeat memories.** Each resumed heartbeat adds a new block of up to `MEMOS_MAX_BLOCK_CHARS` to the conversation, often with the same memories. To limit the cost, lower `MEMOS_MAX_BLOCK_CHARS`. A later version could track injected hashes per session.
- **Dedup marker write can fail after the memory is stored.** The memory still counts as stored and a warning is logged. A redelivered event can then store it a second time. MemOS has no write-if-absent call to close this gap.
- **Comment capture reads the whole thread.** The SDK has no single-comment read, so each agent comment loads all of the issue's comments (5 s limit). On a very long thread the read can time out, and that comment's memories are skipped with a warning.
- **Stdin read error:** the CLI starts with the bytes read so far and no memories, and the wrapper logs a warning.
- **Issue lookup cost:** the wrapper reads `GET /api/issues/:id` for the project, title and description. This fits in the 3 s budget, but a lighter endpoint would leave more time for MemOS.
