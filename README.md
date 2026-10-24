# Linear Intake — Paperclip plugin

Turns Linear issues delegated to the agent user into Paperclip tasks for the Project Lead.

- **When:** a plugin job every 2 minutes (`*/2 * * * *`). An idle tick is one Linear query and no agent run.
- **Which issues:** teams in `teamKeys`, state type `unstarted` (Todo), assignee (or delegate) = the agent user.
- **What it creates:** one task per new Linear key, titled `[KEY] <Linear title>`. The body is the Linear URL only. Assigned to the Project Lead, in the mapped project. Then it wakes the Project Lead.
- **What it never does:** write to Linear, call an LLM, or copy the Linear description, status or comments. The Project Lead owns all Linear writes.

## Idempotency

A key is skipped when either is true:

1. **Plugin state** has the key (company scope, namespace `linear-intake`).
2. **A Paperclip task** in the company has a title that starts with `[KEY]`, in any status. The key is then recorded in state.

The task list is read only when Linear returns a key that is not in state. A restart between "task created" and "key recorded" finds the `[KEY]` task on the next tick, so it makes no duplicate.

## Failures

| Failure | Result |
|---|---|
| Linear HTTP error, GraphQL error, timeout (20 s) or network error | Error in the plugin log, job run marked failed, nothing created. The next tick retries. |
| Mapped Paperclip project not found | Warning; the task goes to the fallback project. |
| Wakeup refused (budget, blockers) | The task stays and the key is recorded; the job run is marked failed. Wake the Project Lead by hand. |
| More than 100 Todo issues | Warning; the rest come in on later ticks as earlier ones leave Todo. |
| No company config yet, or invalid config | Warning or error in the log; no Linear call. |

## Config fields

Config is saved per company. The plugin is single-tenant: configure it in one company only.

| Field | Required | Meaning |
|---|---|---|
| `linearApiKey` | yes | Paperclip secret with a Linear API key that can read the teams. Pick it with the secret picker. |
| `linearAgentUserId` | yes | Linear user id of the agent user. |
| `assignmentField` | no, default `assignee` | `assignee`: the issue is assigned to the agent user. `delegate`: the issue is delegated to it (Linear agent apps). |
| `teamKeys` | no, default `M`, `KNO` | Linear team keys to watch. |
| `projectMap` | no | List of `linearProject` (Linear project id or name) → `paperclipProjectId`. |
| `fallbackProjectId` | yes | Paperclip project for issues with no project, an unmapped project, or a mapped project that is not found. |
| `projectLeadAgentId` | no, default `e18b31d8-e737-4e89-8471-697d59b65453` | Paperclip agent that gets the task and the wakeup. |

## How it works

| Part | Does |
|---|---|
| `src/manifest.ts` | Id `lab.linear-intake`, capabilities, config schema, the job. |
| `src/worker.ts` | Binds to the company whose config the host delivers, runs the job, validates config. |
| `src/intake.ts` | One intake pass: state check, `[KEY]` task check, project choice, create, wakeup, record. |
| `src/linear.ts` | The read-only GraphQL query and its error handling. |
| `src/config.ts` | Config parsing and defaults. |

## Build and check

Needs Node 24+.

```sh
cd /Users/claude/work/workspace/paperclip-linear-intake
npm ci
npm run check     # typecheck + tests + build + manifest validation
```

`npm run validate` checks `dist/manifest.js` with the host's own schema from `/Users/claude/work/paperclip/app/node_modules/@paperclipai/shared`.

## Install on the local `lab` instance

Install needs an instance admin (board) credential. Agent API keys get `403 Board access required`.

1. **Build** in the folder you install from: `npm ci && npm run check` (`dist/` is not committed).
2. **Install** from a board session:

   ```http
   POST /api/plugins/install
   Content-Type: application/json

   { "packageName": "/Users/claude/work/workspace/paperclip-linear-intake", "isLocalPath": true }
   ```

   The CLI sends the same request: `npx paperclipai plugin install --local <path> --api-base http://127.0.0.1:3100`, run from `/Users/claude/work/paperclip/app`.
3. **Approve** the capabilities in Plugin Manager (`/company/settings/instance/plugins`) → **Review**, if the plugin is not `ready`.
4. **Secret:** add the Linear API key as a company secret.
5. **Configure** the plugin in that company with the fields above, and save. Saving delivers the config to the worker; the next 2-minute tick starts intake.
6. **Check:** the plugin's job runs in Plugin Manager show `succeeded`. A test issue assigned to the agent user in Todo shows up as `[KEY] …` for the Project Lead within about 2 minutes.

The host loads the built files in place. After a code change, run `npm run build` and reload or upgrade the plugin from the Plugin Manager.
