# Setup

This package has two parts. They work independently.

| Part | What it does | Where it runs |
|---|---|---|
| **Recall wrapper** (`bin/claude/claude`, `bin/codex/codex`) | Recalls memories **before** the agent CLI receives its prompt | As the adapter `command` |
| **Plugin** (`src/worker.js`, `ui/index.js`) | Turns comments into short memories through the Jev gate. Adds the `memory_recall` and `memory_retain` tools, and the **Memory sharing** settings page | As a Paperclip plugin worker |

## Why a wrapper, not a plugin hook

- **Paperclip 2026.1012.0 has no pre-prompt plugin hook.** `agent.run.started` is published fire-and-forget after the run is `running` (`server/dist/services/heartbeat.js`, `publishRunLifecyclePluginEventData`). The adapter does not wait for it.
- **The adapters honour `config.command`.** The wrapper reads the prompt from stdin and recalls with a hard deadline. Then it injects the memory block and starts the real CLI.
- **The ordering is tested.** `test/wrapper.test.js` checks that the MemOS search response came before the CLI process started.

## Requirements

- Node.js 20.3 or later on the adapter's `PATH`. The wrappers use `#!/usr/bin/env node`. If `node` is missing there, the adapter cannot start the wrapper and the run fails. Check this before you switch an agent over.
- A MemOS server that serves the product API (`POST /product/search`, `POST /product/add`). [SLS-61](/SLS/issues/SLS-61) sets it up.
- An API key for an OpenAI-compatible endpoint (OpenRouter by default), stored as a Paperclip secret. The plugin uses it for the decision model (Jev) and the extract model. Without it the plugin captures nothing; recall still works. It is separate from the keys in `memos.env`, which MemOS uses for embeddings.
- `npm install` in this folder, for the plugin only. The wrapper and the settings page need no dependencies and no build step.

## 1. Install the plugin

1. Install or update it only through the release script, from a merged commit: `node scripts/release-install.mjs memos-memory` (add `--allow-new` on a first install). Run it from a fresh worktree or clone at `origin/main` (root `README.md` → "Run it"). Never `git pull` in `/Users/claude/work/paperclip-plugins-repo` to get the script: until every plugin runs from a release copy, a pull there reloads the live plugins. See the root [`README.md`](../README.md) → "Install and update". The script installs from a read-only release copy. Never install from a checkout: a write there hot-reloads the worker and drops its event subscriptions, so capture stops with no error. The manifest is `src/manifest.js`, the worker `src/worker.js`, the UI `ui/index.js`.
   - **Check after an update:** post a test comment on a task in a captured project. Within about 1 minute, the `shadow-log` route has an entry with that `commentId`.
   - **The recall wrapper is separate.** The adapter `command` path (sections 2 and 3) is not a plugin install, and Paperclip does not watch it.
2. Bind the LLM key to the plugin in each company that uses it:
   1. In the company's plugin settings, find the **LLM provider: OpenAI key** field (`openrouterApiKeyRef`). It is a secret picker, not a text box.
   2. Pick the company secret that holds the key, or use **Create & bind** to make one. Leave the version at `latest` unless you must pin one.
   3. Save. The form stores `{ "type": "secret_ref", "secretId": "<uuid>" }` in `openrouterApiKeyRef`, and Paperclip binds that secret to this plugin at that config path. The plugin can resolve only a bound secret.
   4. Through the API instead: `POST /api/plugins/:id/config` with `companyId` and `configJson.openrouterApiKeyRef` set to that object. The binding is made on the same save. A plain string, also a bare secret UUID, does not work: the config save or the resolve refuses it.
   5. Check: the next agent comment in a captured project gives a `shadow` entry in the `shadow-log` route. If the key does not resolve, the worker log says `OpenAI key (openrouterApiKeyRef) secret could not be resolved` or `is not a secret binding`.
   6. MemOS takes no key. The `memosApiKeyRef` field is gone (SLS-150). A value left in a saved config is ignored.

   The worker keeps a resolved key in memory for 10 minutes, and retries a failed resolve after 1 minute. The host allows 30 resolves a minute per company. A config save clears that company's keys at once, so a rotated key takes effect on save.
3. Set the plugin config. The settings form shows the fields in this order. Each title starts with its group (`Capture: mode`), because the host form has group headings only inside a collapsed "Advanced options" box. The config keys keep their v1 names, so a saved config and its key binding keep working.

| Settings title | Key | Default | Meaning |
|---|---|---|---|
| Capture: mode | `captureMode` | `shadow` | `shadow` logs the verdicts and extracted memories and saves nothing. `save` stores the memories. Switching to `save` is a board decision |
| Capture: projects | `captureProjectIds` | `[]` | Empty = every project. If set, comments, run results and `memory_retain` are captured only for these project IDs. The host form has no project picker, so enter IDs |
| Capture: comments | `captureComments` | `true` | Send new agent and board comments to the decision model |
| Capture: run outcomes | `captureRunOutcomes` | `true` | Send each finished run's newest agent comment to the decision model |
| Decision: model | `jevModel` | `typesafe/jev-1.13` | Keeps or skips each item. Gives probabilities only, writes no text |
| Decision: keep threshold (saveP) | `saveP` | `0.7` | Probability a content question must reach for an item to pass |
| Decision: routine threshold (routineP) | `routineP` | `0.5` | An item whose "routine status only" probability reaches this is skipped |
| Decision: timeout (ms) | `jevTimeoutMs` | `5000` | Timeout for each try. Up to 3 tries |
| Extraction: model | `extractModel` | `~anthropic/claude-haiku-latest` | Writes the short memories (the same Haiku alias MemOS's reader uses) |
| Extraction: timeout (ms) | `extractTimeoutMs` | `15000` | Timeout for each try. Up to 3 tries |
| LLM provider: OpenAI base URL | `openrouterBaseUrl` | `https://openrouter.ai/api/v1` | Base of an OpenAI-compatible API. The extract model calls `/chat/completions`; the decision model calls `/systemone`, which OpenRouter serves. Tests point it at a fake server |
| LLM provider: OpenAI key | `openrouterApiKeyRef` | — | Secret binding (`{ type: "secret_ref", secretId }`) for that API. Capture is off without it. See step 2 |
| MemOS: base URL | `memosBaseUrl` | — | MemOS base URL, for example `http://127.0.0.1:8001`. If it is empty, the plugin does nothing. MemOS takes no key |
| MemOS: capture timeout (ms) | `captureTimeoutMs` | `5000` | Timeout for each MemOS write |
| Recall: max memories (topK) | `topK` | `8` | Maximum number of memories returned |
| Recall: timeout (ms) | `recallTimeoutMs` | `3000` | Deadline for `memory_recall`, across all scopes |
| Alerts: deaf plugin issue | `eventHealthIssue` | `SLS-120` | Issue (identifier or ID) that gets one comment when the plugin stops getting events. Empty logs the error only. See "Deaf plugin alert" |

**Plugin config is per company.** `POST /api/plugins/:id/config` needs a `companyId`, and the config applies to that company only. With an empty `captureProjectIds`, every comment in every project of that company goes to Jev, and every comment Jev passes goes to the extractor. Set `captureProjectIds` for a trial. "Capture all projects" is a board decision.

**Capabilities requested:** `events.subscribe`, `agent.tools.register`, `plugin.state.read`, `plugin.state.write`, `issues.read`, `issue.comments.read`, `issue.comments.create` (the deaf alert only), `projects.read`, `secrets.read-ref`, `jobs.schedule`, `api.routes.register`, `instance.settings.register`.

**Outbound calls use the worker's own `fetch`, not `ctx.http.fetch`.** The host fetch refuses loopback and private addresses, where self-hosted MemOS lives. It also drops the abort signal, so timeouts would not hold. The MemOS and OpenRouter URLs are operator config, not agent input.

## 2. Configure the claude_local adapter

Apply this in the E2E task, not here.

```json
{
  "engine": "cli",
  "command": "/Users/claude/work/workspace/paperclip-plugins/memos-memory/bin/claude/claude",
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
  "command": "/Users/claude/work/workspace/paperclip-plugins/memos-memory/bin/codex/codex",
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
| `MEMOS_PLUGIN_KEY` | `sls.memos-memory` | Plugin key in the sharing lookup URL. Change it only if the plugin is installed under another key |
| `MEMOS_REAL_COMMAND` | first `claude` / `codex` on `PATH` that is not the wrapper | The real CLI |
| `MEMOS_RECALL_DISABLED` | — | `1` turns recall off. The wrapper then only passes the call through |
| `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_TASK_ID` | set by the adapter | The run's scope. The wrapper reads the issue for its project, title and description, then asks the plugin which shared projects that project may read |

`MEMOS_SHARED_SCOPES` is retired. The wrapper ignores it and reads sharing from the plugin.

## Scope and isolation

- **Default scope: company + project.** Each company maps to its own MemOS user (`paperclip-<companyId>`) and each project to its own cube (`paperclip-<companyId>-<projectId>`). Issues without a project use the project key `unscoped`.
- **No cross-company reads.** Every recall builds scopes from the run's own company ID. Sharing settings are stored per company and can only name that company's projects. Results whose metadata names another company or another MemOS user are dropped. Issues from another company are ignored, even if the host returns one.
- **Tools trust the run context's project.** The host takes `runContext.projectId` from the tool request and checks only that the project is in the same company. So `memory_recall` cannot read another company, but a caller could name another project of its own company. `memory_retain` always writes to the run context's project, and refuses an `issueId` from a different project.
- **The agent CLI does not get the MemOS settings.** The wrapper removes every `MEMOS_*` key from the CLI's environment.
- **Remaining risk: MemOS has no per-company auth.** Our checks bind this code, not an agent with a shell. If an agent can reach the MemOS URL, it can query any company's scope by its ID. **Before production,** make MemOS reachable only by the Paperclip host user, not by agent processes. A firewall rule, a socket only that user can open, or a proxy that derives the scope from the run JWT would all work. This belongs to [SLS-61](/SLS/issues/SLS-61) and the E2E task.

## 4. Turn on sharing (opt-in)

Sharing is off by default. The **Memory sharing** page under company settings is the only place to set it.

- **One row per project:** "Readers of this project" is a multi-select of the company's other projects, or **All projects**. An empty row keeps the project private.
- **Who can save:** board users only. The save action refuses agents.
- **Where it lives:** plugin state (`company` scope, namespace `memos-settings`, key `sharing`). It replaces the v1 `sharedScopes` config and `MEMOS_SHARED_SCOPES`.
- **Who reads it:** `memory_recall` reads it directly. The wrapper reads it through the plugin route `GET /api/plugins/sls.memos-memory/api/recall-scopes?projectId=<id>` with the run's own API key. If the lookup fails, the wrapper recalls the own project only.
- **Labels:** recalled memories from a shared project name it, for example `(OPS-3, shared from project "Ops")`. Memories without a label come from the run's own project.
- **Writes never move:** captures always go to the run's own company + project scope.

## What gets captured

| Step | What happens |
|---|---|
| **Items** | Each new agent or board comment (`issue.comment.created`), and each finished run's newest agent comment (`agent.run.finished`). Both use the key `comment:<id>`, so one comment is processed once |
| **Text** | Fenced code blocks and `<details>` sections are cut first. A comment with no prose left is skipped |
| **Jev gate** | One call to `typesafe/jev-1.13`. Questions: has a decision / lesson / outcome / durable fact, and "routine status only". The item passes if a content question is ≥ `saveP` and routine is < `routineP`. Jev never writes text |
| **Extraction** | One Haiku call per passed item: "extract the decisions, lessons, outcomes and facts, one short sentence each, drop routine status". At most 3 memories, 300 characters each, each with its own type. An empty list saves nothing. A reply cut off at `max_tokens` or with invalid JSON keeps its complete memory objects (`salvaged: true`). A reply with no usable list is an `error` verdict, not a retry |
| **Save** | In `save` mode, each memory is a sync `fast` add with our IDs. Raw comment text is never stored |
| **Shadow** | In `shadow` mode (the default), verdicts and extracted memories are logged and nothing is stored. `save` mode logs the verdicts too, see below |

- **Metadata on every memory:** `companyId`, `projectId`, `issueId`, `issueIdentifier`, `commentId`, `runId`, `agentId` or `userId`, `authorType`, `kind` (the memory's type), `jevType`, `jevP`, `itemKey`, `contentHash`, `source`.
- **No blind run note.** v1 stored one note for every succeeded run, and extracted labelled lines with a regex. Both are gone.
- **Recall order:** decisions and lessons first, then outcomes and facts, then older v1 memories, still capped at `topK`.
- **Dedup:** sha256 of the normalized memory text (NFKC, lower case, paired markdown emphasis removed, collapsed spaces, no trailing punctuation), per company + project scope (namespace `memos-dedup`). Items are also marked done (namespace `memos-items`), so a redelivered event makes no second Jev call. In-process locks cover concurrent redelivery.
- **Why the plugin extracts, not MemOS:** see [`docs/sls-99-step1-fine-add.md`](docs/sls-99-step1-fine-add.md).

## Verdict log and report

- **Where:** plugin state, one key per company and UTC day (namespace `memos-shadow`), at most 2000 entries a day, in both modes. Each entry holds `mode`, IDs (including the `projectId` a save writes to), the verdict, Jev probabilities and the cost of both calls. It holds no comment text.
- **Memories:** a `shadow` entry holds the extracted memories. A `save` entry holds only their types (`memoryTypes`) and the add results (`stored`), because the memories are in MemOS, where recall applies sharing.
- **Retries:** a save that fails is logged, then retried, so one item can have several entries. Count the last entry per `key`.
- **Read it:** `GET /api/plugins/sls.memos-memory/api/shadow-log?companyId=<id>&date=YYYY-MM-DD` as a board user or an agent of that company. The answer also lists the items waiting for a retry.
- **Server log:** every verdict is also logged as `memory capture verdict`, in both modes.

## Outages: the retry queue

- **Jev, the extractor or MemOS down:** the item waits in plugin state (`instance` scope, namespace `memos-pending`). It holds IDs only; the text is re-read when the item is retried.
- **Retry job:** `retry-pending-captures` runs every 10 minutes. Waits grow from 10 minutes to 2 hours. After 24 h an item is dropped with a warning. The queue holds at most 1000 items.
- **Inline budget:** an event handler stops after 25 s (the host gives up at 30 s) and leaves the rest to the job. Tasks never wait on capture.
- **Bad key:** 401, 402 and 403 are not retried inside one call; the item still waits for the job.
- **Bad answer, not an outage:** when the extractor answers but no memories list can be read, the item gets an `error` verdict with the reason (finish reason and reply length, never the reply text) and is marked done. At temperature 0 a retry gives the same answer.

## Deaf plugin alert

A hot reload can restart the worker without its event subscriptions (SLS-60). The plugin then stays `ready`, logs nothing and captures nothing, while its jobs keep running.

- **Mark:** every delivered comment or run event writes the time to plugin state (`instance` scope, namespace `memos-health`, key `last-event`, one entry per company). A busy worker writes it at most once a minute.
- **Check:** the `event-health` job runs every minute. A company is deaf when no event came for 10 minutes and an agent or board comment was created after the last event. The comment must be at least 2 minutes old, so an event still on its way does not count. A quiet company with no new comments is never an alert.
- **Which comments count:** only those created at least 1 minute after the stored mark. A busy worker skips mark writes for up to a minute, so an event in that minute leaves no newer mark. Comments the host writes without an event do not count: those with a `presentation`, and those whose `metadata.authorizationReason` is `internal_agent_write`, `onboarding first-task greeting` or `allow_chat_run_presentation`.
- **Alert, once per outage:** one `memory plugin is deaf` error in the log and one comment on `eventHealthIssue`, with the last event time and the newest comment. The alert is saved before the comment is posted: if saving fails, nothing is posted. A failed post is retried on the next run.
- **Recovery:** the next event after the outage logs `memory plugin events are back` and clears the alert. A later outage alerts again.
- **No auto-repair:** only a board user can disable and enable the plugin (Settings → Plugins → MemOS Memory).
- **Forced test:** hot-reload the worker, or set the company's entry in `last-event` back by more than 10 minutes. Either gives exactly one comment once a new comment is 2 minutes old.
- **Wakes no one:** the host never wakes an assignee for a plugin's own comment. The alert waits on the issue until someone reads it.
- **First install:** a company is checked only after its first event, so a worker that is deaf from the start is not detected.
- **Missing alert issue:** the warning is logged once per outage. The post is tried again each minute, so the alert still lands if the issue is created later.

## Failure behaviour

| Failure | Wrapper | Plugin |
|---|---|---|
| MemOS down, 5xx, error code, or slow | Starts the CLI with the original args and prompt, and logs one `[paperclip-memos]` line to stderr after the CLI exits | Recall returns empty. Capture puts the item in the retry queue |
| Jev or extractor down | — | The item waits in the retry queue, up to 24 h |
| Paperclip issue lookup fails | Same as above | The item waits in the retry queue |
| Sharing lookup fails | Recalls the own project only | `memory_recall` reads the own project only |
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
- **Jev and the extractor see comment text.** It goes to OpenRouter (Jev and Haiku). Code blocks and `<details>` are cut first; other secrets pasted in prose are not.
- **The run result is a comment.** The SDK gives plugins no read of a run's own result, so the run event uses the run's newest agent comment.
- **`memory_retain` is not gated.** It stores what the agent wrote, in both modes. It is an explicit call, not capture.
- **The shadow log ignores sharing.** In `shadow` mode, any agent of the company can read the extracted memories of every project through `shadow-log`. It stays open to agents because an agent writes the report. In `save` mode the log holds no memory text.
- **Archived projects leave sharing.** When the page saves, shares of an archived project are dropped with a log line. Unarchiving the project later does not bring them back. Set them again on the page.
- **Double signals outside Paperclip.** Started by a non-job-control `sh -c` under a terminal, the wrapper is not group leader but shares the group with the CLI. Ctrl-C then reaches the CLI twice, and Claude treats that as "exit now". Paperclip spawns the wrapper as group leader, so this does not happen there.
- **Resumed sessions repeat memories.** Each resumed heartbeat adds a new block of up to `MEMOS_MAX_BLOCK_CHARS` to the conversation, often with the same memories. To limit the cost, lower `MEMOS_MAX_BLOCK_CHARS`. A later version could track injected hashes per session.
- **An add counts as stored only with created memory IDs.** MemOS answers `/product/add` with HTTP 200 even when it stores nothing, for example when its embedder fails ("No add/update items prepared"). An answer with no `memory_id` is a failed add: no dedup marker, and the item waits in the retry queue with the reason `memos: MemOS answered with no created memory IDs` (shown in the verdict log and the queue's `lastError`, without memory text). Seen in [SLS-147](/SLS/issues/SLS-147), fixed in [SLS-149](/SLS/issues/SLS-149).
- **Dedup marker write can fail after the memory is stored.** The memory still counts as stored and a warning is logged. A redelivered event can then store it a second time. MemOS has no write-if-absent call to close this gap.
- **Decision effects can give a false deaf alert.** A board decision with a `comment_on_issue` effect writes a board comment with no event and no mark that tells it apart. If no other event comes for 10 minutes after one, the plugin alerts.
- **The deaf check reads up to 25 threads.** Only when no event came for 10 minutes: it lists the company's issues and reads the comments of those with activity after the last event, newest first.
- **Comment capture reads the whole thread.** The SDK has no single-comment read, so each comment loads all of the issue's comments (5 s limit). On a very long thread the read can time out, and the item waits in the retry queue.
- **Stdin read error:** the CLI starts with the bytes read so far and no memories, and the wrapper logs a warning.
- **Issue lookup cost:** the wrapper reads `GET /api/issues/:id` for the project, title and description. This fits in the 3 s budget, but a lighter endpoint would leave more time for MemOS.
