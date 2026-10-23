// Render the sidebar rows beside the host's own nav items, styled by the
// host's real CSS bundle. Writes evidence/preview-v4.html. Open it in a
// browser: a script in the page measures the icon and label x positions of
// every row and prints whether the plugin rows line up with the nav items.
//
// Usage: node scripts/render-preview.mjs [path/to/host/ui-dist]
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const uiDist = path.resolve(
  process.argv[2] ?? "/Users/claude/work/paperclip/app/node_modules/@paperclipai/server/ui-dist",
);
const cssFile = readdirSync(path.join(uiDist, "assets")).find((f) => /^index-.*\.css$/.test(f));
if (!cssFile) throw new Error(`no index-*.css in ${uiDist}/assets`);
const cssHref = pathToFileURL(path.join(uiDist, "assets", cssFile)).href;

const entry = `
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { UsageLimitsView, buildRowViews } from "./src/ui/index.tsx";

const NOW = Date.parse("2026-10-23T18:46:00.000Z");
const MIN = 60000, HOUR = 60 * MIN;
const CLAUDE = { slug: "anthropic", label: "Claude" };
const CODEX = { slug: "openai", label: "Codex" };
const COMPANY = "c1";

// Newest rate_limit_event found in the lab run logs on 2026-10-23 (smoke run).
const realSnap = { at: Date.parse("2026-10-23T18:44:01.913Z"), status: "allowed_warning",
  fiveHour: { utilization: 11, resetsAt: 1792795200000 }, sevenDay: { utilization: 83, resetsAt: 1792832400000 } };
const runLog = (snapshot, error = null) => ({ v: 1, companyId: COMPANY, attemptAt: NOW - MIN, inFlightUntil: 0,
  checkedAt: NOW - MIN, snapshot, error });
// Codex as the owner's account reports it: primary window is weekly, plus $0 credits.
const quota = (results) => ({ v: 1, lastAttemptAt: NOW - MIN, inFlightUntil: 0, fetchedAt: NOW - MIN, results,
  fetchError: null, lastGood: {}, failures: 0, nextAt: NOW + 4 * MIN });
const codexOk = { provider: "openai", ok: true, windows: [
  { label: "5h limit", usedPercent: 3, resetsAt: new Date(NOW + 6 * 24 * HOUR + 2 * HOUR).toISOString(), valueLabel: null },
  { label: "Credits", usedPercent: null, resetsAt: null, valueLabel: "$0.00 remaining" } ] };
const claude429 = { provider: "anthropic", ok: false, windows: [], error: "anthropic usage api returned 429" };
const codex429 = { provider: "openai", ok: false, windows: [], error: "chatgpt wham api returned 429" };

const rowsView = (rl, q) => ({ kind: "rows", rows: buildRowViews([CLAUDE, CODEX], rl, q, COMPANY, NOW).rows });
export const cases = [
  ["Live data (Claude from run log, Codex from usage API)", rowsView(runLog(realSnap), quota([claude429, codexOk]))],
  ["Claude event older than its 5-hour reset", rowsView(runLog({ ...realSnap, at: NOW - 6 * HOUR,
    fiveHour: { utilization: 95, resetsAt: NOW - HOUR } }), quota([claude429, codexOk]))],
  ["No data anywhere", rowsView(runLog(null, "No rate_limit_event in recent Claude run logs"), quota([claude429, codex429]))],
  ["Provider list failed", { kind: "error", message: "worker not ready" }],
];
export const render = (view) => renderToStaticMarkup(createElement(UsageLimitsView, view));
`;

const outfile = path.resolve("dist/preview-entry.mjs");
await build({
  stdin: { contents: entry, resolveDir: process.cwd(), loader: "tsx" },
  bundle: true,
  outfile,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  packages: "external",
  alias: { "@paperclipai/plugin-sdk/ui": "./scripts/sdk-ui-stub.mjs" },
});
const { cases, render } = await import(pathToFileURL(outfile).href);
rmSync(outfile);

// Host markup, copied from the host bundle: SidebarNavItem (link), SidebarSection
// body, and the PluginSlotOutlet / PluginSlotMount wrappers around a sidebar slot.
const NAV_LINK =
  "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium transition-colors text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";
const ICONS = {
  Tasks: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  Projects: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  Routines: '<path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/>',
  Artifacts: '<path d="M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8"/>',
  Workspaces: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  Agents: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
};
const navItem = (label) =>
  '<a href="#" class="' + NAV_LINK + '"><span data-slot="sidebar-nav-icon" class="relative shrink-0">' +
  '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  ICONS[label] + '</svg></span><span class="min-w-0 flex-1 truncate">' + label + "</span></a>";
const header = (label) =>
  '<div class="px-3 py-1.5"><span class="text-(length:--text-nano) font-medium uppercase tracking-widest font-mono text-muted-foreground/60">' +
  label + "</span></div>";
const sidebar = (pluginHtml) =>
  '<aside class="w-full flex flex-col border-r border-border bg-background"><nav class="flex min-h-0 flex-1 flex-col gap-4 px-3 py-2">' +
  "<div>" + header("Work") + '<div class="flex flex-col gap-0.5 mt-0.5">' +
  ["Tasks", "Projects", "Routines", "Artifacts", "Workspaces"].map(navItem).join("") +
  '<div class="flex flex-col gap-0.5"><div class="text-(length:--text-compact) font-medium">' + pluginHtml + "</div></div>" +
  "</div></div>" +
  "<div>" + header("Org") + '<div class="flex flex-col gap-0.5 mt-0.5">' + navItem("Agents") + "</div></div>" +
  "</nav></aside>";

const titleOf = (html) =>
  [...html.matchAll(/title="([^"]*)"/g)].map((m) => m[1].replace(/&#x27;/g, "'").replace(/&quot;/g, '"')).join("\n\n");

const sections = cases
  .map(([title, view]) => {
    const html = render(view);
    const panel = (theme) => '<div class="' + theme + ' col"><div class="frame">' + sidebar(html) + "</div></div>";
    return '<section><h3>' + title + '</h3><div class="pair">' + panel("light") + panel("dark") +
      '</div><pre class="tip">' + titleOf(html) + "</pre></section>";
  })
  .join("\n");

const check = `
<script>
(() => {
  const out = [];
  let bad = 0;
  for (const frame of document.querySelectorAll(".frame")) {
    const rows = [...frame.querySelectorAll('[data-slot="sidebar-nav-icon"]')].map((icon) => {
      const row = icon.parentElement;
      const label = row.lastElementChild;
      const r = row.getBoundingClientRect(), i = icon.getBoundingClientRect(), l = label.getBoundingClientRect();
      const cs = getComputedStyle(label);
      return { plugin: !!row.closest("[data-plugin]"), text: label.textContent, rowX: r.left, iconX: i.left, iconW: i.width,
        iconH: i.height, labelX: l.left, h: r.height, font: cs.fontSize + "/" + cs.lineHeight + " " + cs.fontWeight };
    });
    const ref = rows.find((r) => !r.plugin);
    for (const r of rows.filter((x) => x.plugin)) {
      const same = ["rowX", "iconX", "iconW", "iconH", "labelX", "h", "font"].every((k) => r[k] === ref[k]);
      if (!same) bad++;
      out.push((same ? "OK  " : "OFF ") + JSON.stringify(r) + (same ? "" : "  vs nav " + JSON.stringify(ref)));
    }
  }
  const el = document.getElementById("check");
  el.textContent = (bad === 0 ? "ALIGNED: every plugin row matches the nav items (row x, icon x/size, label x, height, font).\\n"
    : bad + " plugin row(s) differ from the nav items.\\n") + out.join("\\n");
  el.className = bad === 0 ? "ok" : "bad";
})();
</script>`;

mkdirSync("evidence", { recursive: true });
writeFileSync(
  "evidence/preview-v4.html",
  `<!doctype html><html><head><meta charset="utf-8"><title>Usage limits v0.4 preview</title>
<!-- Host CSS: ${path.join(uiDist, "assets", cssFile)} -->
<link rel="stylesheet" href="${cssHref}">
<style>
body{font-family:system-ui;padding:16px;background:#e4e4e7}
section{margin-bottom:24px}h3{font:600 13px system-ui;margin:0 0 6px}
.pair{display:flex;gap:16px}.col{width:240px}.frame{border-radius:8px;overflow:hidden;border:1px solid #d4d4d8}
.tip{font:11px/1.4 ui-monospace,monospace;white-space:pre-wrap;background:#fff;border:1px solid #d4d4d8;padding:6px;max-width:496px;margin-top:6px}
#check{font:11px/1.4 ui-monospace,monospace;white-space:pre-wrap;padding:8px;border-radius:6px}
#check.ok{background:#dcfce7}#check.bad{background:#fee2e2}
</style></head><body>
<h2 style="font:600 15px system-ui;margin:0 0 8px">Usage limits v0.4: plugin rows (Claude, Codex) under the host's Work nav items</h2>
<pre id="check">Open in a browser to run the alignment check.</pre>
${sections}
${check}
</body></html>
`,
);
for (const [title, view] of cases) {
  const rows = view.kind === "rows" ? view.rows.map((r) => `${r.slug}: ${r.text}`).join(" | ") : `error: ${view.message}`;
  console.log(`${title}\n  ${rows}`);
}
console.log(`\nwrote evidence/preview-v4.html (host CSS ${cssFile})`);
