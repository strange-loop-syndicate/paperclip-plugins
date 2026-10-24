# Bang Commands — Paperclip plugin

Write `!<command>` as a task comment. The plugin runs it and posts exit code,
duration and output as a reply on the same task. Only comments by the user ids
in `ALLOWED_USER_IDS` (`src/commands.ts`, default `local-board`) trigger anything.

- `!<shortcut>` alone → the shortcut below.
- `!help` → list of shortcuts.
- Anything else after `!` → runs in `/bin/zsh -lc` in `/Users/claude/work/workspace`,
  timeout 120 s. Multi-line comments run as one script.

## Shortcuts

| Comment | Runs | Changes anything |
|---|---|---|
| `!status` | Paperclip `/api/health` plus local patch state | No |
| `!git-status-lab` | `git status -sb` in `workspace/lab` | No |
| `!git-pull-lab` | `git pull --ff-only` in `workspace/lab` | Yes (fails today: no remote) |
| `!check-updates` | installed vs npm-latest `paperclipai` version, plus patch state | No |
| `!restart-paperclip` | `scripts/restart-paperclip.sh`, detached, 5 s delay | Restarts the server |

The list lives in `src/commands.ts`. Edit it, then `npm run build`.

## Rules

- **Allowed users only.** Events with `actorType` other than `user`, comments
  with an agent author, and users not in `ALLOWED_USER_IDS` are ignored.
  The plugin's own replies are `plugin` events, so no loops.
- **Any comment starting with `!` runs.** Do not start ordinary comments with `!`.
  Exception: `![` (a markdown image, such as a pasted screenshot) runs nothing and posts nothing; the plugin only wakes the assignee.
- **Timeout** per command. The process group is killed with SIGKILL.
- **Output** is truncated to the last 6000 characters.
- **`!restart-paperclip`** replies "started" first, then runs detached in its own
  process group. Its log is `detached-restart-paperclip.log` in this folder.
  It stops every running agent run.

## Known limits

- In `local_trusted` mode any local process can post a comment as the board user.
  "Owner only" is a soft check. Commands run as the server's OS user (`claude`),
  the same user agents already run as, so this adds no OS privilege.
- Unpatched Paperclip wakes the task's agent on the `!` comment itself, about 30 ms
  later. The agent then starts before the reply exists, and the reply arrives as a
  queued "interrupt" message. See "Agent wake order" below.

## Agent wake order

Paperclip wakes the assignee inside the comment request, before any plugin sees the
comment. A plugin cannot stop that wake. Two parts fix the order:

1. **Server patch** — `bang-wake` in `/Users/claude/work/paperclip/patches` (git repo,
   own README) edits the installed `@paperclipai/server/dist/routes/issues.js`: a user
   comment that starts with `!` wakes no agent. It touches only the two comment-wake guards.
2. **Plugin wake** — after it posts the reply, the plugin calls `issues.requestWakeup`
   (reason `bang_command_result`). The agent starts with the output already in the thread.
   `!help` and detached shortcuts wake nobody.

```sh
node /Users/claude/work/paperclip/patches/apply-all.mjs --check   # exit 0 = all patches applied
```

- **Update Paperclip with** `npm run update-paperclip` in `/Users/claude/work/paperclip/app`.
  It re-applies the patches. `!restart-paperclip` also re-applies them before it starts the server.
- **Plugin off = `!` comments wake nobody** while the patch is in place.
- **The patch applies to every user's `!` comment**, not only `ALLOWED_USER_IDS`.

## Develop

```sh
npm install
npm test        # unit tests, harness-based
npm run build   # dist/worker.js + dist/manifest.js
```

Install (board action, run by the owner) from the `paperclip-plugins` checkout at
`/Users/claude/work/paperclip-plugins-repo`. The older `/Users/claude/work/paperclip-plugins/`
folder holds the pre-move checkout and is not this repo.

```sh
cd /Users/claude/work/paperclip/app
./node_modules/.bin/paperclipai plugin install --local /Users/claude/work/paperclip-plugins-repo/bang-commands
```

Local-path installs are watched: after `npm run build` the host restarts the worker.

Scaffolded with `@paperclipai/create-paperclip-plugin@2026.1012.0`, then the UI
template was removed and the SDK switched to the published npm package.
