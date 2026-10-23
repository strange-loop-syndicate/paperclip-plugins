# Usage Limits — Paperclip plugin

Shows Claude and Codex subscription usage windows in the Paperclip sidebar.

- **Where:** a `sidebarPanel` below the company navigation.
- **What:** per provider, each window (5h, 7d, model-specific, credits) with % used, a bar and the reset time.
- **Which providers:** only those used by a non-terminated company agent (`claude_local` → Claude, `codex_local` → Codex).
- **Errors:** a provider that fails, times out or is missing shows `Unavailable — <reason>`.
- **Refresh:** on open, every 120 s while the tab is visible, on tab focus (30 s minimum gap), and with the ↻ button.

## How it works

| Part | Does |
|---|---|
| `src/worker.ts` | Data handler `used-providers`: lists company agents (`agents.read`) and maps adapter types to providers. |
| `src/ui/index.tsx` | Sidebar panel. Calls the existing board-only route `GET /api/companies/:companyId/costs/quota-windows` with the signed-in board session. |
| `src/mapping.ts` | Pure mapping from agents + quota response to panels. Unit-tested. |

The plugin keeps no credentials and does not call provider APIs itself. The host's adapters do that inside the quota route.

## Build and check

Needs Node 24+.

```sh
cd /Users/claude/work/workspace/paperclip-limits-plugin
npm ci
npm run check     # typecheck + tests + build + manifest validation
npm run preview   # optional: static HTML of every panel state -> evidence/preview.html
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
3. Open any company. The **Usage limits** panel shows below the sidebar navigation.

The host loads the built files in place. After a code change, run `npm run build` and reload or upgrade the plugin from the Plugin Manager.
