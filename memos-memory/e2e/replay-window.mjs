// SLS-200 step 5: replay the capture rules on a past window of comments,
// without saving to any real cube. Items come from the verdict log; Jev and
// the extractor run in the plugin worker through the dry-run route.
// Subcommands batches | dedup | report; usage: docs/sls-200-noise-fix.md.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMemosClient } from "../src/memos-client.js";
import { scopeFor } from "../src/scope.js";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const BATCH = 10;

// batches <logDir> <fromIso> <toIso> <outDir>: dry-run bodies, oldest first.
function batches([logDir, from, to, outDir]) {
  const seen = new Set();
  const items = [];
  for (const f of readdirSync(logDir).filter((x) => /^log-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
    for (const e of JSON.parse(readFileSync(join(logDir, f), "utf8")).entries ?? []) {
      if (e.at < from || e.at >= to || !e.issueId || !e.commentId || seen.has(e.commentId)) continue;
      seen.add(e.commentId);
      items.push({ at: e.at, issueId: e.issueId, commentId: e.commentId, source: e.source === "run" ? "run" : "comment" });
    }
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    n += 1;
    const comments = items.slice(i, i + BATCH).map(({ at, ...c }) => c);
    writeFileSync(join(outDir, `batch-${String(n).padStart(3, "0")}.json`), JSON.stringify({ comments }));
  }
  console.log(`${items.length} items in ${n} batches`);
}

function readResults(dir) {
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.startsWith("result-")).sort()) out.push(...(JSON.parse(readFileSync(join(dir, f), "utf8")).results ?? []));
  return out;
}

// dedup <memosUrl> <resultsDir> <out.json> [--at 0.85]: the save-mode
// duplicate check, in comment order, on a throwaway probe-company cube.
async function dedup([memosUrl, resultsDir, out]) {
  const at = Number(flag("--at", "0.85"));
  const client = createMemosClient({ baseUrl: memosUrl, logger: { warn: (m) => console.error(m) } });
  const scope = scopeFor({ companyId: "e2e-probe-company", projectId: `sls200-replay-${Date.now()}` });
  const rows = [];
  for (const r of readResults(resultsDir)) {
    for (const m of r.memories ?? []) {
      const hits = await client.search({ scope, query: m.content, topK: 3, timeoutMs: 15000 });
      const best = Math.max(-1, ...hits.map((h) => Number(h.metadata?.relativity)).filter(Number.isFinite));
      const duplicate = best >= at;
      if (!duplicate) {
        const add = await client.add({ scope, content: m.content, metadata: { kind: m.type }, timeoutMs: 20000 });
        if (!add.ok) throw new Error(`probe add failed: ${add.error}`);
      }
      rows.push({ commentId: r.commentId, issueIdentifier: r.issueIdentifier, type: m.type, content: m.content, best: Math.round(best * 1000) / 1000, duplicate });
    }
  }
  writeFileSync(out, JSON.stringify({ scope: scope.cubeId, at, rows }, null, 1));
  console.log(JSON.stringify({ probeCube: scope.cubeId, memories: rows.length, duplicates: rows.filter((x) => x.duplicate).length }));
}

/** mulberry32: a small seeded generator, so the sample can be drawn again. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// report <resultsDir> <dedup.json> <out.md> [--sample 30] [--seed 200]
function report([resultsDir, dedupFile, out]) {
  const size = Number(flag("--sample", "30"));
  const rand = rng(Number(flag("--seed", "200")));
  const results = readResults(resultsDir);
  const { rows, at } = JSON.parse(readFileSync(dedupFile, "utf8"));
  const tally = (xs) => xs.reduce((acc, x) => ((acc[x] = (acc[x] ?? 0) + 1), acc), {});
  const stored = rows.filter((x) => !x.duplicate);
  const pool = [...stored];
  const sample = [];
  while (sample.length < size && pool.length) sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  const summary = {
    items: results.length,
    verdicts: tally(results.map((r) => r.verdict)),
    extracted: results.reduce((n, r) => n + (r.memories?.length ?? 0) + (r.dropped?.length ?? 0), 0),
    droppedByCode: tally(results.flatMap((r) => (r.dropped ?? []).map((d) => d.reason))),
    passedRules: rows.length,
    duplicatesAt: at,
    duplicates: rows.length - stored.length,
    wouldStore: stored.length,
    types: tally(stored.map((x) => x.type)),
  };
  const lines = [
    "```json",
    JSON.stringify(summary, null, 1),
    "```",
    "",
    "| # | Task | Type | Memory | Grade |",
    "|---|---|---|---|---|",
    ...sample.map((x, i) => `| ${i + 1} | ${x.issueIdentifier ?? ""} | ${x.type} | ${x.content.replace(/\|/g, "\\|")} |  |`),
  ];
  writeFileSync(out, lines.join("\n"));
  console.log(JSON.stringify(summary));
}

if (cmd === "batches") batches(args);
else if (cmd === "dedup") await dedup(args);
else if (cmd === "report") report(args);
else {
  console.error("usage: replay-window.mjs batches|dedup|report …  (docs/sls-200-noise-fix.md)");
  process.exit(2);
}
