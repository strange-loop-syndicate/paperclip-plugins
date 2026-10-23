// Render the sidebar panel to static HTML with fixture data (no host needed).
// Covers ok, warn/critical, unavailable and empty states. Writes evidence/preview.html.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const entry = `
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { UsageLimitsView } from "./src/ui/index.tsx";
import { buildPanels } from "./src/mapping.ts";

const now = new Date("2026-10-23T12:00:00.000Z");
const CLAUDE = { slug: "anthropic", label: "Claude" };
const CODEX = { slug: "openai", label: "Codex" };
const ok = [
  { provider: "anthropic", ok: true, windows: [
    { label: "5h", usedPercent: 37.4, resetsAt: "2026-10-23T14:30:00.000Z", valueLabel: null },
    { label: "7d", usedPercent: 78, resetsAt: "2026-10-27T09:00:00.000Z", valueLabel: null },
    { label: "Sonnet 7d", usedPercent: 93, resetsAt: "2026-10-27T09:00:00.000Z", valueLabel: null },
  ] },
  { provider: "openai", ok: true, windows: [
    { label: "5h", usedPercent: 12, resetsAt: "2026-10-23T13:10:00.000Z", valueLabel: null },
    { label: "Credits", usedPercent: null, resetsAt: null, valueLabel: "$4.20 remaining" },
  ] },
];
const cases = [
  ["Both providers, live-shaped data", { kind: "panels", panels: buildPanels([CLAUDE, CODEX], ok, null, now) }],
  ["Codex errors, Claude ok", { kind: "panels", panels: buildPanels([CLAUDE, CODEX], [ok[0], { provider: "openai", ok: false, error: "quota polling timed out after 20s", windows: [] }], null, now) }],
  ["Quota request failed", { kind: "panels", panels: buildPanels([CLAUDE], null, "Quota request failed (403 Forbidden: Board access required)", now) }],
  ["Claude on Bedrock (no windows)", { kind: "panels", panels: buildPanels([CLAUDE], [{ provider: "anthropic", source: "bedrock", ok: true, windows: [] }], null, now) }],
  ["No Claude/Codex agents", { kind: "none" }],
];
const sections = cases.map(([title, view]) =>
  '<section><h3>' + title + '</h3><div class="sidebar">' +
  renderToStaticMarkup(createElement(UsageLimitsView, { view, loading: false, updatedAt: null })) +
  '</div></section>').join("\\n");
export default sections;
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
section{width:240px}h3{font-size:12px;margin:0 0 6px}.sidebar{background:#fff;border:1px solid #e4e4e7;border-radius:6px}</style>
${html}\n`,
);
console.log(html);
console.log("\nwrote evidence/preview.html");
