# Usage Limits — Paperclip plugin

Shows Claude and Codex subscription usage in the Paperclip sidebar.

- **Where:** one plain row per used provider in the sidebar nav list, after Projects/Workspaces (`sidebar` slot). No expand, no detail box.
- **Row:** provider logo + `X% Y% <reset>`, one space apart, e.g. `14% 84% 2:30`. X = 5-hour window used, Y = weekly window used, `<reset>` = time to the next 5-hour reset (the weekly reset when the 5-hour value is unknown).
- **Reset format:** `H:MM` under 24 h (`0:05`, `2:30`); compact days from 24 h (`3d4h`, `6d`). An unknown part shows `—`, e.g. `— 3% 6d`.
- **Alignment:** the row uses the host's own nav item classes (`SidebarNavItem`): same icon column and 16 px size, same label x, font size, weight and line height as Routines, Artifacts and the rest.
- **Hover:** the `title` carries full labels, both reset times, the data source and its age, and any reason for missing data.
- **No data:** logo + `—`, reason in the hover title. A window whose reset time has passed since the data was read shows `—`, never an old or 0% value.
- **Which providers:** only those used by a non-terminated company agent (`claude_local` → Claude, `codex_local` → Codex).

## Where the numbers come from

| Provider | Source | Refresh |
|---|---|---|
| Claude | Anthropic OAuth usage API (`GET https://api.anthropic.com/api/oauth/usage`), read by the plugin worker for the account Claude Code is signed in as | Every 60 s, shared with the interactive status line |
| Codex | `GET /api/companies/:id/costs/quota-windows` (the host polls OpenAI) | Every 5 min, backoff 10/20/30 min on failure |

**Claude, the same way as the status line** (`~/.claude/hooks/statusline.sh`, `refresh_usage_api`):

1. **Cache:** read `~/.claude/usage-exact.json`. If it is younger than 60 s, and not older than `.credentials.json` (an account switch rewrites that file), use it. Interactive sessions refresh it every 60 s.
2. **Refresh:** else take the status line's lock directory `/tmp/statusline-refresh.lock.d` (a lock older than 30 s is reaped). Read the token from `$CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude`), call the API with `anthropic-beta: oauth-2025-04-20`, and write `usage-exact.json` atomically in the status line's shape. One poll per 60 s across the status line and the plugin.
3. **Failure (429, network, rejected token):** keep the last good file value. The hover shows its time and the reason. A `Retry-After` header pauses calls for that long; without one, the next 60 s tick retries.
4. **Account:** the hover names the token's own account, from `GET https://api.anthropic.com/api/oauth/profile` (as cca does). One call per token, kept in memory. Not `~/.claude.json`: live sessions rewrite its `oauthAccount` from their own copy, so it can name the previous account. Only when the profile call fails does the hover show that email, marked "from .claude.json, may lag an account switch".

- **Never the keychain:** a locked keychain opens a modal password dialog.
- **Token:** kept in worker memory for one request. Never logged, cached or returned to the browser.
- **Run logs are not a source:** their `rate_limit_event`s carry no account, so after an account switch they mixed accounts (SLS-188).

## Shared cache (Codex)

The quota-windows route uses one `localStorage` entry per browser (`lab.usage-limits.quota.v1`), a Web Lock so only one tab fetches, and an in-flight marker. It holds the last response, last good windows per provider, failure count and next fetch time.

## How it works

| Part | Does |
|---|---|
| `src/worker.ts` | Data handlers `used-providers` (lists company agents, `agents.read`) and `claude-usage`. |
| `src/claude-usage.ts` | Claude usage: shared cache file, lock, usage API call, 429 handling. Unit-tested. |
| `src/rows.ts` | Row model and formatter: `X% Y% reset`, hover title, reset-since handling, source choice. Unit-tested. |
| `src/mapping.ts` | Quota-windows response → panels (stale data, Codex label fix, `$0` credits). Unit-tested. |
| `src/cache.ts` | Quota-windows fetch/backoff decisions. Unit-tested. |
| `src/ui/index.tsx` | Sidebar rows. |
| `src/ui/store.ts`, `src/ui/shared-store.ts` | Codex quota-windows browser cache; calls the board route with the signed-in board session. |
| `src/ui/icons.tsx` | Claude and Codex marks, the host's own `/brands` artwork (Lobe Icons, MIT). |

The worker calls one provider API itself: the Anthropic usage API, with the Claude Code token from `.credentials.json` (capability `http.outbound`). The plugin stores no credentials.

## Build and check

Needs Node 24+.

In a worktree of this repo, not in a folder Paperclip loads:

```sh
npm ci
npm run check     # typecheck + tests + build + manifest validation
npm run preview   # rows beside the host's nav items, host CSS, alignment check -> evidence/preview-v4.html
```

`npm run validate` checks `dist/manifest.js` with the host's own schema from `/Users/claude/work/paperclip/app/node_modules/@paperclipai/shared`. Pass another path as the first argument if the host lives elsewhere.

## Install on the local `lab` instance

Install needs an instance admin (board) credential. Agent API keys get `403 Board access required`.

Install or update only through the release script, from a merged commit (root [`README.md`](../README.md) → "Install and update"). It builds a read-only release copy and installs from it. Never install from a checkout, and never use the CLI or API install by hand.

```sh
node scripts/release-install.mjs usage-limits              # update
node scripts/release-install.mjs usage-limits --allow-new  # first install
```

Run it from a fresh worktree or clone at `origin/main` (root `README.md` → "Run it"). Never `git pull` in `/Users/claude/work/paperclip-plugins-repo` to get the script: until every plugin runs from a release copy, a pull there reloads the live plugins.

**Then, on a first install:**

1. Open http://127.0.0.1:3100 → company settings → instance → **Plugin Manager** (`/company/settings/instance/plugins`).
2. If the plugin is not `ready`, open **Review** and approve `agents.read`, `http.outbound` and `ui.sidebar.register`.
3. Open any company. The usage rows show in the sidebar nav, after Projects.

- **Check after an update:** reload any company page. The usage rows in the sidebar show values, not an error.
