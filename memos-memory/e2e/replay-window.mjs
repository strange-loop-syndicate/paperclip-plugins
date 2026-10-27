// SLS-200 step 5: replay the capture rules on a past window of comments,
// without saving to any real cube. Items come from the verdict log; Jev and
// the extractor run in the plugin worker through the dry-run route.
// Subcommands batches | dedup | report, and embed | judge-batches | final for
// the duplicate judge; usage: docs/sls-200-noise-fix.md.

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
  for (const f of readdirSync(dir).filter((x) => /^result-\d+\.json$/.test(x)).sort()) out.push(...(JSON.parse(readFileSync(join(dir, f), "utf8")).results ?? []));
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

// embed <memosUrl> <resultsDir> <state.json>: add every memory that passed the
// rules to a new probe-company cube (6 at a time), keeping comment order.
async function embed([memosUrl, resultsDir, out]) {
  const rows = [];
  for (const r of readResults(resultsDir)) for (const m of r.memories ?? []) rows.push({ order: rows.length, issue: r.issueIdentifier, type: m.type, content: m.content });
  const scope = scopeFor({ companyId: "e2e-probe-company", projectId: `sls200-replay-${Date.now()}` });
  const client = createMemosClient({ baseUrl: memosUrl, logger: { warn: (m) => console.error(m) } });
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      const res = await client.add({ scope, content: row.content, metadata: { kind: row.type, order: row.order }, timeoutMs: 60000 });
      if (!res.ok) throw new Error(`probe add ${row.order} failed: ${res.error}`);
      row.memoryId = res.memoryIds[0];
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  writeFileSync(out, JSON.stringify({ memosUrl, cube: scope.cubeId, user: scope.userId, rows }));
  console.log(JSON.stringify({ probeCube: scope.cubeId, memories: rows.length }));
}

const cos = (x, y) => {
  let d = 0, p = 0, q = 0;
  for (let i = 0; i < x.length; i += 1) {
    d += x[i] * y[i];
    p += x[i] ** 2;
    q += y[i] ** 2;
  }
  return d / Math.sqrt(p * q);
};

async function embeddings(state) {
  const body = { mem_cube_id: state.cube, user_id: state.user, include_preference: false, include_tool_memory: false, include_skill_memory: false };
  const json = await (await fetch(`${state.memosUrl.replace(/\/+$/, "")}/product/get_memory`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const walk = (x, acc = []) => {
    if (Array.isArray(x)) x.forEach((v) => walk(v, acc));
    else if (x && typeof x === "object") {
      if (typeof x.memory === "string" && x.metadata) acc.push(x);
      else Object.values(x).forEach((v) => walk(v, acc));
    }
    return acc;
  };
  const byId = new Map(walk(json.data).map((m) => [m.id ?? m.metadata.id, m.metadata.embedding]));
  return state.rows.map((r) => byId.get(r.memoryId) ?? null);
}

// judge-batches <state.json> <outDir> [--at 0.80] [--floor 0.70]: the cosine
// check against every older memory; the rest with older hits from --floor up
// become dry-run `duplicates` bodies (top 3 hits each).
async function judgeBatches([stateFile, outDir]) {
  const at = Number(flag("--at", "0.80"));
  const floor = Number(flag("--floor", "0.70"));
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const emb = await embeddings(state);
  if (emb.some((e) => !e)) throw new Error("a probe memory has no embedding");
  const cosineDup = [];
  const asks = [];
  for (let i = 0; i < state.rows.length; i += 1) {
    const older = state.rows.slice(0, i).map((r, k) => ({ order: r.order, text: r.content, score: cos(emb[i], emb[k]) })).sort((a, b) => b.score - a.score);
    if (older[0] && older[0].score >= at) cosineDup.push({ order: i, of: older[0].order, score: older[0].score });
    else {
      const candidates = older.filter((o) => o.score >= floor).slice(0, 3);
      if (candidates.length) asks.push({ id: String(i), text: state.rows[i].content, candidates: candidates.map((c) => c.text), candidateOrders: candidates.map((c) => c.order) });
    }
  }
  mkdirSync(outDir, { recursive: true });
  for (let i = 0; i < asks.length; i += BATCH) {
    const duplicates = asks.slice(i, i + BATCH).map(({ candidateOrders, ...a }) => a);
    writeFileSync(join(outDir, `batch-${String(i / BATCH + 1).padStart(3, "0")}.json`), JSON.stringify({ duplicates }));
  }
  writeFileSync(stateFile.replace(/\.json$/, "-judge-plan.json"), JSON.stringify({ at, floor, cosineDup, asks: asks.map(({ id, candidateOrders }) => ({ id, candidateOrders })) }));
  console.log(JSON.stringify({ memories: state.rows.length, cosineDuplicates: cosineDup.length, judgeAsks: asks.length, batches: Math.ceil(asks.length / BATCH) }));
}

// final <state.json> <judgeResultsDir> <out.md> [--sample 30] [--seed 200]:
// a memory is a duplicate when the cosine check or the judge says it repeats
// an older one; counts, the kept pairs from --floor up to check by hand, and
// a seeded sample of the kept memories.
async function finalReport([stateFile, judgeDir, out]) {
  const size = Number(flag("--sample", "30"));
  const rand = rng(Number(flag("--seed", "200")));
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const plan = JSON.parse(readFileSync(stateFile.replace(/\.json$/, "-judge-plan.json"), "utf8"));
  const verdicts = new Map(readResults(judgeDir).map((r) => [r.id, r]));
  const dup = new Map(plan.cosineDup.map((d) => [d.order, `cosine ${d.score.toFixed(3)}`]));
  let judgeErrors = 0;
  for (const a of plan.asks) {
    const v = verdicts.get(a.id);
    if (!v || v.verdict === "error") judgeErrors += 1;
    else if (v.verdict === "duplicate") dup.set(Number(a.id), "judge");
  }
  const kept = state.rows.filter((r) => !dup.has(r.order));
  const emb = await embeddings(state);
  const pairs = [];
  for (let i = 1; i < kept.length; i += 1) {
    let best = 0, bj = -1;
    for (let k = 0; k < i; k += 1) {
      const c = cos(emb[kept[i].order], emb[kept[k].order]);
      if (c > best) [best, bj] = [c, k];
    }
    if (best >= plan.floor) pairs.push({ score: best, newer: kept[i], older: kept[bj] });
  }
  const pool = [...kept];
  const sample = [];
  while (sample.length < size && pool.length) sample.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  const esc = (t) => t.replace(/\|/g, "\\|");
  const summary = { probeCube: state.cube, passedRules: state.rows.length, cosineDuplicates: plan.cosineDup.length, judgeAsks: plan.asks.length, judgeDuplicates: [...dup.values()].filter((v) => v === "judge").length, judgeErrors, kept: kept.length, keptPairsFromFloor: pairs.length };
  const lines = [
    "```json", JSON.stringify(summary, null, 1), "```", "",
    "| # | Task | Type | Memory | Grade |", "|---|---|---|---|---|",
    ...sample.map((x, i) => `| ${i + 1} | ${x.issue ?? ""} | ${x.type} | ${esc(x.content)} |  |`), "",
    "| Pair | Cosine | Judged | Newer memory | Older memory |", "|---|---|---|---|---|",
    ...pairs.sort((a, b) => b.score - a.score).map((p, i) => `| P${i + 1} | ${p.score.toFixed(3)} |  | ${esc(p.newer.content)} | ${esc(p.older.content)} |`),
  ];
  writeFileSync(out, lines.join("\n"));
  console.log(JSON.stringify(summary));
}

if (cmd === "batches") batches(args);
else if (cmd === "embed") await embed(args);
else if (cmd === "judge-batches") await judgeBatches(args);
else if (cmd === "final") await finalReport(args);
else if (cmd === "dedup") await dedup(args);
else if (cmd === "report") report(args);
else {
  console.error("usage: replay-window.mjs batches|dedup|report|embed|judge-batches|final …  (docs/sls-200-noise-fix.md)");
  process.exit(2);
}
