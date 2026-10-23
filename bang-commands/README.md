# Bang Commands — Paperclip plugin

Write `!<name>` as a task comment. The plugin runs the matching allowlisted
command and posts exit code, duration and output as a reply on the same task.

## Commands

| Comment | Runs | Changes anything |
|---|---|---|
| `!status` | `curl` Paperclip `/api/health` | No |
| `!git-status-lab` | `git status -sb` in `workspace/lab` | No |
| `!git-pull-lab` | `git pull --ff-only` in `workspace/lab` | Yes (fails today: no remote) |
| `!check-updates` | installed vs npm-latest `paperclipai` version | No |
| `!restart-paperclip` | `scripts/restart-paperclip.sh`, detached, 5 s delay | Restarts the server |

The list lives in `src/commands.ts`. Edit it, then `npm run build`.

## Rules

- **Allowlist only.** The whole comment must be `!<name>`. No arguments, no shell.
  `!<known-name> <more>` gets a "takes no arguments" reply. Unknown `!<name>` gets the list.
  Prose such as `!important note` is ignored.
- **User comments only.** Events with `actorType` other than `user`, and comments
  with an agent author, are ignored. The plugin's own replies are `plugin` events, so no loops.
- **Timeout** per command. The process group is killed with SIGKILL.
- **Output** is truncated to the last 6000 characters.
- **`!restart-paperclip`** replies "started" first, then runs detached in its own
  process group. Its log is `detached-restart-paperclip.log` in this folder.
  It stops every running agent run.

## Known limits

- In `local_trusted` mode any local process can post a comment as the board user.
  "User only" is a soft check.
- Plugin replies do not wake the task's agent. The agent sees the reply on its next wake.
  The `!` comment itself does wake the agent, which may start before the reply exists.

## Develop

```sh
npm install
npm test        # unit tests, harness-based
npm run build   # dist/worker.js + dist/manifest.js
```

Install (board action, run by the owner):

```sh
cd /Users/claude/work/paperclip/app
./node_modules/.bin/paperclipai plugin install --local /Users/claude/work/paperclip-plugins/paperclip-plugin-bang-commands
```

Local-path installs are watched: after `npm run build` the host restarts the worker.

Scaffolded with `@paperclipai/create-paperclip-plugin@2026.1012.0`, then the UI
template was removed and the SDK switched to the published npm package.
