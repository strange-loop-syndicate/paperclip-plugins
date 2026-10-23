# Usage Limits — Paperclip plugin

Shows Claude and Codex subscription usage windows in the Paperclip sidebar.

- **Where:** one line in the sidebar nav list, right after Projects/Workspaces (`sidebar` slot), e.g. `Claude 82% · Codex 0%`. The value is the highest-used window per provider, coloured by severity.
- **Detail:** hover for every window with reset times and full errors. Click to expand the per-window detail, with a link to Costs and a ↻ button.
- **Which providers:** only those used by a non-terminated company agent (`claude_local` → Claude, `codex_local` → Codex).
- **Errors:** a provider that fails keeps its last good windows, marked `stale · as of HH:MM`, with a short reason such as `Rate-limited by Anthropic, retrying in 10m`. Only a provider with no good data at all shows the reason alone.
- **Labels:** a Codex "5h limit" whose reset is more than 5 h away shows as "Weekly limit". A `$0.00` credits row next to subscription windows moves to the tooltip.

## Refresh and the shared cache

The quota route has no server cache, and each call reaches the Anthropic and OpenAI usage APIs. The plugin keeps one cache for all tabs of a browser.

| Rule | Value |
|---|---|
| Cache | `localStorage` key `lab.usage-limits.quota.v1`: last response, last good windows per provider, failure count, next fetch time |
| One fetcher | Web Lock `lab.usage-limits.fetch`, plus an in-flight marker (45 s) in the cache |
| Normal interval | 5 min across all tabs; each visible tab checks the cache every 30 s |
| Backoff | a failed used provider or failed request: 10, 20, then 30 min max |
| Manual ↻ | skips the backoff, never more than once per 60 s |

## How it works

| Part | Does |
|---|---|
| `src/worker.ts` | Data handler `used-providers`: lists company agents (`agents.read`) and maps adapter types to providers. |
| `src/ui/index.tsx` | Sidebar line and expanded detail. |
| `src/ui/store.ts` | Shared browser cache. Calls the existing board-only route `GET /api/companies/:companyId/costs/quota-windows` with the signed-in board session. |
| `src/cache.ts` | Pure fetch/backoff decisions and cache updates. Unit-tested. |
| `src/mapping.ts` | Pure mapping from agents + quota response to panels, compact line, tooltip, relabel. Unit-tested. |

The plugin keeps no credentials and does not call provider APIs itself. The host's adapters do that inside the quota route.

## Build and check

Needs Node 24+.

```sh
cd /Users/claude/work/workspace/paperclip-limits-plugin
npm ci
npm run check     # typecheck + tests + build + manifest validation
npm run preview   # optional: static HTML of the ok / stale / rate-limited states -> evidence/preview.html
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
3. Open any company. The usage line shows in the sidebar nav, after Projects.

The host loads the built files in place. After a code change, run `npm run build` and reload or upgrade the plugin from the Plugin Manager.
