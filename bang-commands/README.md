# Bang Commands — Paperclip plugin

Write `!<command>` as a task comment. The plugin runs it and posts exit code,
duration and output as a reply on the same task. Only comments by the user ids
in `ALLOWED_USER_IDS` (`src/commands.ts`, default `local-board`) trigger anything.

- `!<shortcut>` alone → the shortcut below.
- `!help` → list of shortcuts.
- Anything else after `!` → runs in `/bin/zsh -lc` in `/Users/claude/work/workspace`,
  timeout 120 s. Multi-line comments run as one script.

## Special characters

The comment editor stores Markdown, not the text you typed. The plugin turns it
back into your text before it runs, so `!FOO_ID=1 env` runs `FOO_ID=1 env`, not
`FOO\_ID\=1 env`.

| Editor stores | Runs as |
|---|---|
| `\` + punctuation: `\_` `\=` `\*` `\<` `\[` `` \` `` `\\` … | that character (`\\` → one `\`) |
| `\` + anything else (`\n`, `\w`) | unchanged |
| `&#x20;` `&#x9;` (spaces and tabs at a line start or end) | the space or tab |
| `&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&nbsp;`, `&#NN;`, `&#xNN;` | the character (a no-break space becomes a space) |
| a blank line between lines (Enter) | one newline; an empty line you typed stays empty |
| `\` or two spaces at a line end (Shift+Enter) | a newline |
| `[text](url)` (a URL the editor turned into a link) | `text`, the URL as typed |
| `` `x` `` (backticks the editor turned into inline code) | `` `x` ``, unchanged |

**A code block or code span runs byte-for-byte.** If the whole text after `!` is one
fenced code block (```` ``` ```` or `~~~`, any language) or one inline code span, its
content runs exactly as written, with no unescaping, and never as a shortcut. Text mixed
with code blocks is unescaped, and each block's content is kept as is. Use a code block when
the editor changes your text, for example:

- `_x_` typed as you go can turn into italics, which the editor stores as `*x*`.
- a command that you post through the API, not the editor (its body is not Markdown).

The rules come from the installed editor (MDXEditor with `mdast-util-to-markdown`, then
Paperclip's `toStoredMarkdown`). The tests serialize typed text with the same library and
rules, then check that it runs as typed (`tests/editor.ts`).

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
- **Any comment starting with `!` runs**, after the unescaping in "Special characters".
  Do not start ordinary comments with `!`.
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

## Install and update

Board action. Only through the release script, from a merged commit (see the root
[`README.md`](../README.md) → "Install and update"):

```sh
node scripts/release-install.mjs bang-commands
```

Run it from a fresh worktree or clone at `origin/main` (root `README.md` → "Run it"). Never `git pull` in `/Users/claude/work/paperclip-plugins-repo` to get the script: until every plugin runs from a release copy, a pull there reloads the live plugins.

Never install from a checkout: a build or `git pull` there hot-reloads the worker and
drops its `issue.comment.created` subscription.

- **Check after a switch:** as a board user, post `!status` on any task. The plugin replies
  with the status output within a few seconds.

Scaffolded with `@paperclipai/create-paperclip-plugin@2026.1012.0`, then the UI
template was removed and the SDK switched to the published npm package.
