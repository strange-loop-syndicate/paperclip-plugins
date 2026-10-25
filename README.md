# paperclip-plugins

Strange Loop Syndicate plugins for Paperclip. One folder per plugin.

| Folder | Plugin |
|---|---|
| [`memos-memory/`](memos-memory/) | Memory backed by self-hosted MemOS, plus the pre-prompt recall wrapper for `claude_local` and `codex_local` |
| [`usage-limits/`](usage-limits/) | Claude and Codex subscription usage limits in the sidebar |
| [`bang-commands/`](bang-commands/) | Runs `!<command>` task comments from allowed users and replies with the output |
| [`linear-intake/`](linear-intake/) | Turns Linear issues delegated to the agent user into `[KEY] …` tasks for the Project Lead |

- **Rules:** [`AGENTS.md`](AGENTS.md), then the plugin folder's own `AGENTS.md`.

## Install and update

### ✋ Never point Paperclip at a working checkout

- **Why:** Paperclip watches the folder of every plugin installed from a local path. Any write there (`git pull`, `npm install`, a test run) hot-reloads the worker. That reload skips activation (`plugin-lifecycle.js:470`, upstream #14335), so the plugin loses its event subscriptions. It stays `ready` and logs nothing.
- **Rule:** Paperclip loads each plugin only from a release copy, `/Users/claude/work/paperclip-plugins-releases/<plugin>/<sha>/`. Installs and updates go only through `scripts/release-install.mjs`. Never install from this checkout, a worktree, or by hand.

### Run it

Needs Node 24+ and a board credential. Agent API keys get `403 Board access required`.

```sh
git -C /Users/claude/work/paperclip-plugins-repo fetch origin
git -C /Users/claude/work/paperclip-plugins-repo worktree add --detach /Users/claude/work/workspace/.worktrees/paperclip-plugins-release origin/main
cd /Users/claude/work/workspace/.worktrees/paperclip-plugins-release
node scripts/release-install.mjs memos-memory --dry-run   # build the copy, print the plan
node scripts/release-install.mjs memos-memory             # switch to the tip of origin/main
node scripts/release-install.mjs memos-memory 1b0189a     # or to a given merged commit
```

- **✋ First switch (Paperclip task SLS-143):** run the script from a fresh worktree or clone at `origin/main`, as above. Never `git pull` in `/Users/claude/work/paperclip-plugins-repo` for it: that checkout has no `scripts/` yet, and a pull reloads all four live plugins and drops their subscriptions. `git fetch` and `git worktree add` write only under `.git/`, which Paperclip does not watch.
- **✋ Restart once after the first switch:** after a plugin's first switch from a checkout path to a release copy, restart the Paperclip server once. Do it before any build, `npm install` or `git pull` in that checkout. **Why:** API installs do not move the dev watcher, so it keeps watching the old checkout path until a restart (proof: SLS-143, 2026-10-25). The script prints `RESTART NEEDED` when the previous path was not under the releases folder.
- **Later switches:** a switch from one release copy to another needs no restart. The old watch then points at a read-only copy that nothing writes.
- **Source:** a commit on `origin/main`, default its tip. The script runs `git fetch` and refuses a sha that is not on `origin/main`. It never reads the working tree, so any checkout of this repo works.
- **Release copy:** `git archive` of `<sha>:<plugin>`, then `npm ci` and the plugin's checks (`npm run check`, or `typecheck`, `build` and `test` where there is no `check`). It builds in a `.tmp-*` folder, makes it read-only, then renames it into place. An existing complete copy (with `.release.json`) is reused. The build log is `.release-build.log` in the copy.
- **Switch:** soft uninstall (`DELETE /api/plugins/<id>`, no purge), then `POST /api/plugins/install` with the release path. `install` answers 409 for a plugin that is still installed. The soft uninstall keeps the plugin row, so the ID, config and plugin state stay. `install` then runs `lifecycle.load` → `activateReadyPlugin`, the same full activation that `enable` runs.
- **Checks:** before, it records ID, key, version, status, packagePath and each company's config. After, it checks status `ready`, the same ID and key, the manifest version of that sha, packagePath = the release copy, and unchanged config. Any mismatch exits 1.
- **Rollback:** if `install` fails, the script reinstalls from the previous packagePath. `install` can fail after it has set the row to `ready` at the new path (the worker does not start). The script then soft-uninstalls again before it reinstalls, and checks that the plugin is `ready` at the previous path.
- **Records:** `before.json` and `after.json` in `/Users/claude/work/paperclip-plugins-releases/_installs/<plugin>/<time>/`.
- **Undo:** the script prints the previous packagePath. To go back to an older release, run the script with that release's sha. The release folder is reused.
- **Credential:** `$PAPERCLIP_BOARD_TOKEN`, else the `paperclipai` CLI board login for that API base (`$PAPERCLIP_AUTH_STORE`, else `$PAPERCLIP_HOME/auth.json`, else `~/.paperclip/auth.json`). The token is never printed. `--api-base` defaults to `$PAPERCLIP_API_URL` or `http://127.0.0.1:3100`.
- **First install:** a plugin key that Paperclip does not know needs `--allow-new`. Then follow the plugin's own README for capability approval and config.

### Release folder rules

- **Never write** in a release folder after install. They are read-only on purpose. No plugin writes into its own folder at runtime (checked 2026-10-25). A plugin that must do so goes in `RUNTIME_WRITES` in the script.
- **Never delete** an old release folder, not even an unused one. Deleting a watched folder can trigger the same reload.

### Check that a plugin gets events after a switch

Run the check for the plugin you switched. Also check the server log: after the restart that follows the first switch, a `git pull` or a test run in this checkout must give no `plugin-dev-watcher: file change detected` line for any plugin. Before that restart, it still does.

| Plugin | How to prove it works |
|---|---|
| `memos-memory` | Post a test comment on a task in a captured project. Within about 1 minute, `GET /api/plugins/sls.memos-memory/api/shadow-log?companyId=<id>` has an entry with that `commentId`. The server log also has `memory capture verdict` for it. |
| `bang-commands` | As a board user, post `!status` on any task. The plugin replies with the status output within a few seconds. Agent comments never trigger it. |
| `linear-intake` | No events, a job every 2 minutes. Within 2 minutes of the switch, Plugin Manager → Linear Intake → job runs shows a new `succeeded` run. |
| `usage-limits` | No events or jobs. Reload any company page. The usage rows in the sidebar show values, not an error. |

### Test the script

```sh
node --test "scripts/test/*.test.mjs"
```

The tests use a temp git origin and a stub Paperclip API. They need no live server and no network.
