# Usage Limits — Paperclip plugin

Shows Claude and Codex subscription usage in the Paperclip sidebar.

- **Where:** one plain row per used provider in the sidebar nav list, after Projects/Workspaces (`sidebar` slot). No expand, no detail box.
- **Row:** provider logo + `X% / Y% / <reset>`, e.g. `11% / 83% / 3h 54m`. X = 5-hour window used, Y = weekly window used, `<reset>` = time to the next 5-hour reset (the weekly reset when the 5-hour value is unknown).
- **Alignment:** the row uses the host's own nav item classes (`SidebarNavItem`): same icon column and 16 px size, same label x, font size, weight and line height as Routines, Artifacts and the rest.
- **Hover:** the `title` carries full labels, both reset times, the data source and its age, and any reason for missing data.
- **No data:** logo + `—`, reason in the hover title. A window whose reset time has passed since the data was read shows `—`, never an old or 0% value.
- **Which providers:** only those used by a non-terminated company agent (`claude_local` → Claude, `codex_local` → Codex).

## Where the numbers come from

| Provider | Source | Refresh |
|---|---|---|
| Claude | Newest `rate_limit_event` in the company's `claude_local` run logs (Claude Code stream-json, escaped inside each log `chunk`) | Every 2 min, shared by all tabs |
| Codex | `GET /api/companies/:id/costs/quota-windows` (the host polls OpenAI) | Every 5 min, backoff 10/20/30 min on failure |
| Claude fallback | The same quota-windows route, only while the run logs give no value | As Codex |

The Anthropic usage API behind the quota-windows route returns 429 for this account most of the time. The run logs carry the same limits on every Claude turn, so they are the primary source. The quota-windows route is not called at all when only Claude is used and its run logs have data.

**Run-log scan (bounded):**

1. `GET /api/companies/:id/heartbeat-runs?limit=30&summary=true` — the board's own run list.
2. Keep runs of the company's `claude_local` agents, newest activity first, at most 6.
3. `GET /api/heartbeat-runs/:runId/log?offset=…&limitBytes=…` — the last 256 KB of a finished log. If that has no event, or the run is still running (size unknown), the first 64 KB.
4. Stop as soon as no remaining run was active after the newest event found. Newest event by log time wins.

On the lab logs a scan reads 1–3 runs.

## Shared cache

Both sources use one `localStorage` entry per browser, a Web Lock so only one tab fetches, and an in-flight marker.

| Entry | Key | Holds |
|---|---|---|
| Run log | `lab.usage-limits.runlog.v1` | newest event, company, last scan time, reason when nothing was found |
| Quota windows | `lab.usage-limits.quota.v1` | last response, last good windows per provider, failure count, next fetch time |

## How it works

| Part | Does |
|---|---|
| `src/worker.ts` | Data handler `used-providers`: lists company agents (`agents.read`), returns used providers and agent IDs per provider. |
| `src/runlog.ts` | Run-log parser, bounded run scan and run-log cache decisions. Unit-tested. |
| `src/rows.ts` | Row model and formatter: `X% / Y% / reset`, hover title, reset-since handling, source choice. Unit-tested. |
| `src/mapping.ts` | Quota-windows response → panels (stale data, Codex label fix, `$0` credits). Unit-tested. |
| `src/cache.ts` | Quota-windows fetch/backoff decisions. Unit-tested. |
| `src/ui/index.tsx` | Sidebar rows. |
| `src/ui/runlog-store.ts`, `src/ui/store.ts`, `src/ui/shared-store.ts` | Browser caches; call the board routes with the signed-in board session. |
| `src/ui/icons.tsx` | Claude and Codex marks, the host's own `/brands` artwork (Lobe Icons, MIT). |

The plugin keeps no credentials and calls no provider API itself.

## Build and check

Needs Node 24+.

```sh
cd /Users/claude/work/workspace/paperclip-limits-plugin
npm ci
npm run check     # typecheck + tests + build + manifest validation
npm run preview   # rows beside the host's nav items, host CSS, alignment check -> evidence/preview-v3.html
```

`npm run validate` checks `dist/manifest.js` with the host's own schema from `/Users/claude/work/paperclip/app/node_modules/@paperclipai/shared`. Pass another path as the first argument if the host lives elsewhere.

## Install on the local `lab` instance

Install needs an instance admin (board) credential. Agent API keys get `403 Board access required`.

The Plugin Manager's **Install Plugin** dialog takes npm names only. A local folder outside the Paperclip checkout installs through the CLI or the API.

**CLI** (uses the stored board login for that API base; add `--api-key <board token>` if there is none):

```sh
cd /Users/claude/work/workspace/paperclip-limits-plugin && npm ci && npm run check
cd /Users/claude/work/paperclip/app
npx paperclipai plugin install --local /Users/claude/work/workspace/paperclip-limits-plugin --api-base http://127.0.0.1:3100
```

**API** (same request the CLI sends, from a board session):

```http
POST /api/plugins/install
Content-Type: application/json

{ "packageName": "/Users/claude/work/workspace/paperclip-limits-plugin", "isLocalPath": true }
```

**Then:**

1. Open http://127.0.0.1:3100 → company settings → instance → **Plugin Manager** (`/company/settings/instance/plugins`).
2. If the plugin is not `ready`, open **Review** and approve `agents.read` and `ui.sidebar.register`.
3. Open any company. The usage rows show in the sidebar nav, after Projects.

The host loads the built files in place. After a code change, run `npm run build` and reload or upgrade the plugin from the Plugin Manager.
