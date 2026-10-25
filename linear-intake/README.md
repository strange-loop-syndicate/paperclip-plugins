# Linear Intake — Paperclip plugin

Turns Linear issues delegated to the agent user into Paperclip tasks for the Project Lead.

- **When:** a plugin job every 2 minutes (`*/2 * * * *`). An idle tick is one Linear query and no agent run (plus one user lookup after a worker start, when the agent user is given by name).
- **Which issues:** teams in `teamKeys`, state type `unstarted` (Todo), delegate (or assignee) = the agent user.
- **What it creates:** one task per new Linear key, titled `[KEY] <Linear title>`. The body is the Linear URL only. Status `todo`, assigned to the Project Lead, created by the Project Director (`createdByAgentId`), in the Paperclip project with the same name as the Linear project. Then it wakes the Project Lead.
- **What it never does:** write to Linear, call an LLM, or copy the Linear description, status or comments. The Project Lead owns all Linear writes.

## Idempotency

A key is skipped when either is true:

1. **Plugin state** has the key (company scope, namespace `linear-intake`).
2. **A Paperclip task** in the company has a title that starts with `[KEY]`, in any status. The key is then recorded in state.

The task list is read only when Linear returns a key that is not in state. It is read in one call with no `limit`: the host applies `offset` twice, so offset paging would stop after the first page. A restart between "task created" and "key recorded" finds the `[KEY]` task on the next tick, so it makes no duplicate.

## Failures

| Failure | Result |
|---|---|
| Linear HTTP error, GraphQL error, timeout (20 s) or network error | Error in the plugin log, job run marked failed, nothing created. The next tick retries. |
| `linearAgentUser` matches no Linear user, or more than one | Error in the log naming the value and the matches; job run marked failed, nothing created. The next tick retries. |
| `fallbackProject`, `projectLeadAgentId` or `creatorAgent` matches no project/agent, or more than one | Same: error, job failed, nothing created. Checked only on a tick that has an issue to create. |
| No Paperclip project has the Linear project's name | The task goes to the fallback project. One warning per run lists the unmatched Linear project names. |
| Two Paperclip projects have the name, or a `projectMap` target is not found | Warning; the task goes to the fallback project. |
| Wakeup refused (budget, blockers) | The task stays and the key is recorded; the job run is marked failed. The wakeup is not retried. Wake the Project Lead by hand. |
| More than 100 Todo issues | Warning; only the first 100 are read. Issues past them are read only after earlier ones leave Todo, so the Project Lead must move taken issues out of Todo. |
| No company config yet, or invalid config | Warning or error in the log; no Linear call. |

## Config fields

Config is saved per company. The plugin is single-tenant: configure it in one company only.
Only `linearApiKey` is required. Every other field has a working default, and takes a **name** where a human would look one up.

| Field | Default | Meaning |
|---|---|---|
| `linearApiKey` | — (required) | Paperclip secret with a Linear API key that can read the teams. Pick it with the secret picker. |
| `linearAgentUser` | `Claude Code` | Linear user that issues are delegated to: name, display name or email (case is ignored), or a Linear user id. Looked up through the Linear API once per worker start. |
| `assignmentField` | `delegate` | `delegate`: the issue is delegated to the agent user (Linear agent apps). `assignee`: the issue is assigned to it. |
| `teamKeys` | `M`, `KNO` | Linear team keys to watch. |
| `fallbackProject` | `Ops` | Paperclip project name or id, for issues with no Linear project or no project of the same name. |
| `projectMap` | empty | Optional overrides, only where names differ: `linearProject` (Linear project name or id) → `paperclipProject` (Paperclip project name or id). An override wins over the name match. |
| `projectLeadAgentId` | `e18b31d8-e737-4e89-8471-697d59b65453` | Paperclip agent that gets the task and the wakeup: an id, or a name such as `Project Lead`. |
| `creatorAgent` | `Project Director` | Paperclip agent recorded as the task's creator (`createdByAgentId`): a name or an id. Chain-of-command rules send questions on a root `[KEY]` task to its creator. |

**Project choice.** A `projectMap` override wins. Otherwise the issue goes to the non-archived Paperclip project whose name equals the Linear project name, compared case-insensitively after trimming spaces. Otherwise it goes to `fallbackProject`.

**Name rules.** A Paperclip project or agent value matches an exact id first, then a name (case-insensitive). A Linear user value that is a UUID is used as is. A name that matches nothing, or more than one, is an error that names the matches; use the id or the email then.

**Configs saved before 0.2.0** keep working. The old fields are read when the new field is empty: `linearAgentUserId` (for `linearAgentUser`), `fallbackProjectId` (for `fallbackProject`), and `projectMap[].paperclipProjectId` (for `paperclipProject`). The old default `assignmentField` was `assignee`; a saved config keeps whatever value it holds.

## How it works

| Part | Does |
|---|---|
| `src/manifest.ts` | Id `lab.linear-intake`, capabilities, config schema, the job. |
| `src/worker.ts` | Binds to the company whose config the host delivers, runs the job, validates config. |
| `src/intake.ts` | One intake pass: state check, `[KEY]` task check, project choice, create, wakeup, record. |
| `src/linear.ts` | The read-only GraphQL queries (issues, user lookup) and their error handling. |
| `src/resolve.ts` | Names to ids: the Linear user, Paperclip projects and the Project Lead agent. |
| `src/config.ts` | Config parsing, defaults and the old id fields. |

## Build and check

Needs Node 24+.

In a worktree of this repo, not in a folder Paperclip loads:

```sh
npm ci
npm run check     # typecheck + tests + build + manifest validation
```

`npm run validate` checks `dist/manifest.js` with the host's own schema from `/Users/claude/work/paperclip/app/node_modules/@paperclipai/shared`. It also runs the host's config validator on a key-only config and on a config with the old id fields.

## Install on the local `lab` instance

Install needs an instance admin (board) credential. Agent API keys get `403 Board access required`.

1. **Install or update** only through the release script, from a merged commit (root [`README.md`](../README.md) → "Install and update"). It builds a read-only release copy (`dist/` is not committed) and installs from it. Never install from a checkout.

   ```sh
   node scripts/release-install.mjs linear-intake              # update
   node scripts/release-install.mjs linear-intake --allow-new  # first install
   ```

   Run it from a fresh worktree or clone at `origin/main` (root `README.md` → "Run it"). Never `git pull` in `/Users/claude/work/paperclip-plugins-repo` to get the script: until every plugin runs from a release copy, a pull there reloads the live plugins.

2. **Approve** the capabilities in Plugin Manager (`/company/settings/instance/plugins`) → **Review**, if the plugin is not `ready`.
3. **Secret:** add the Linear API key as a company secret.
4. **Configure** the plugin in that company: pick the secret in `linearApiKey` and save. The other fields keep their defaults unless a name differs. Saving delivers the config to the worker; the next 2-minute tick starts intake.
5. **Check:** the plugin's job runs in Plugin Manager show `succeeded`. A test issue assigned to the agent user in Todo shows up as `[KEY] …` for the Project Lead within about 2 minutes.

- **Check after an update:** within 2 minutes, Plugin Manager → Linear Intake → job runs shows a new `succeeded` run. An update keeps the config, so steps 2–4 are for a first install only.

0.2.0 adds the `agents.read` capability (to find the Project Lead by name), so the upgrade may ask for capability approval again.

**0.2.1** creates tasks in `todo` and with the Project Director as creator. Before it, tasks landed in the host default `backlog`, so the wakeup failed with `Issue is not wakeable in status: backlog`, and `createdByAgentId` was empty. No capability or required config changes.
