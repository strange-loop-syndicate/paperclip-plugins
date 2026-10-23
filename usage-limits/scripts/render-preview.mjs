// Render the sidebar line to static HTML with fixture data (no host needed).
// Covers the ok, stale and rate-limited states, collapsed and expanded. Writes evidence/preview.html.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const entry = `
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { UsageLimitsView } from "./src/ui/index.tsx";
import { buildPanels, compactItem } from "./src/mapping.ts";

const now = new Date("2026-10-23T12:00:00.000Z");
const MIN = 60000;
const CLAUDE = { slug: "anthropic", label: "Claude" };
const CODEX = { slug: "openai", label: "Codex" };
const claudeOk = { provider: "anthropic", ok: true, windows: [
  { label: "Current session", usedPercent: 82, resetsAt: "2026-10-23T14:10:00.000Z", valueLabel: null },
  { label: "Current week (all models)", usedPercent: 41, resetsAt: "2026-10-27T09:00:00.000Z", valueLabel: null },
  { label: "Current week (Sonnet only)", usedPercent: 12, resetsAt: "2026-10-27T09:00:00.000Z", valueLabel: null },
] };
// Codex as the owner saw it: primary_window labelled "5h limit" but weekly, plus $0 credits.
const codexOk = { provider: "openai", ok: true, windows: [
  { label: "5h limit", usedPercent: 0, resetsAt: "2026-10-30T11:00:00.000Z", valueLabel: null },
  { label: "Credits", usedPercent: null, resetsAt: null, valueLabel: "$0.00 remaining" },
] };
const claude429 = { provider: "anthropic", ok: false, windows: [],
  error: "Claude subscription session found, but quota polling failed (Anthropic OAuth usage: anthropic usage api returned 429; Claude CLI /usage: claude exited with code 1)" };
const lastGood = { anthropic: { windows: claudeOk.windows, fetchedAt: now.getTime() - 25 * MIN } };
const retry = now.getTime() + 10 * MIN;

function panelsView(results, extra = {}) {
  const input = { results, fetchedAt: results ? now.getTime() - MIN : null, fetchError: null, lastGood: {}, retryAt: null, ...extra };
  const panels = buildPanels([CLAUDE, CODEX], input, now);
  return { kind: "panels", panels, items: panels.map((p) => compactItem(p, input, now)) };
}
const cases = [
  ["OK", panelsView([claudeOk, codexOk])],
  ["Stale: Claude 429, older data kept", panelsView([claude429, codexOk], { lastGood, retryAt: retry })],
  ["Rate-limited: Claude 429, no older data", panelsView([claude429, codexOk], { retryAt: retry })],
];
const nav = (label) => '<div class="nav-item">' + label + '</div>';
const render = (view, expanded) => renderToStaticMarkup(createElement(UsageLimitsView, {
  view, expanded, loading: false, notice: null, costsLink: { href: "#costs" } }));
const sections = cases.map(([title, view]) =>
  '<section><h3>' + title + '</h3>' +
  '<p class="cap">Collapsed (hover = tooltip)</p><div class="sidebar">' + nav("Projects") + render(view, false) + nav("Costs") + '</div>' +
  '<p class="cap">Expanded (click)</p><div class="sidebar">' + render(view, true) + '</div>' +
  '</section>').join("\\n");
const tooltips = cases.map(([title, view]) => {
  const m = render(view, false).match(/title="([^"]*)"/);
  return '<section><h3>Tooltip — ' + title + '</h3><pre>' + (m ? m[1] : "") + '</pre></section>';
}).join("\\n");
export default sections + "\\n" + tooltips;
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

const { default: html } = await import(pathToFileURL(outfile).href);
rmSync(outfile);

mkdirSync("evidence", { recursive: true });
writeFileSync(
  "evidence/preview.html",
  `<!doctype html><meta charset="utf-8"><title>Usage limits preview</title>
<style>body{font-family:system-ui;background:#f4f4f5;color:#18181b;padding:16px;display:flex;flex-wrap:wrap;gap:16px}
section{width:260px}h3{font-size:12px;margin:0 0 6px}.cap{font-size:11px;color:#71717a;margin:8px 0 4px}
.sidebar{background:#fff;border:1px solid #e4e4e7;border-radius:6px;padding:4px 0;font-size:13px}
.nav-item{margin:0 8px;padding:6px 8px;color:#3f3f46;opacity:.8}pre{font-size:11px;white-space:pre-wrap;background:#fff;border:1px solid #e4e4e7;padding:6px}</style>
${html}\n`,
);
console.log(html);
console.log("\nwrote evidence/preview.html");
