// SLS-206 probe: run this checkout's duplicate judge on saved pairs and count
// the verdicts. Stores nothing and reads no MemOS. One judge call per pair.
// Usage: OPENROUTER_API_KEY=… node e2e/judge-pairs.mjs <pairs.json> [model] [baseUrl]
// <pairs.json> is a list of { id, text, candidates: [text, …] } (1 to 3), the
// shape of the dry-run route's `duplicates` body. The key is never printed.
import { readFileSync } from "node:fs";
import { createDupJudge } from "../src/dupjudge.js";
import { EXTRACT_MODEL, EXTRACT_TIMEOUT_MS } from "../src/extractor.js";

const [pairsFile, model = EXTRACT_MODEL, baseUrl = "https://openrouter.ai/api/v1"] = process.argv.slice(2);
const apiKey = process.env.OPENROUTER_API_KEY;
if (!pairsFile || !apiKey) {
  console.error("usage: OPENROUTER_API_KEY=… node e2e/judge-pairs.mjs <pairs.json> [model] [baseUrl]");
  process.exit(2);
}
const pairs = JSON.parse(readFileSync(pairsFile, "utf8"));
const judge = createDupJudge({ apiKey, model, url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`, timeoutMs: EXTRACT_TIMEOUT_MS });

const tally = { calls: 0, duplicate: 0, new: 0, noVerdict: 0, otherError: 0 };
let costUsd = 0;
for (const p of pairs) {
  tally.calls += 1;
  try {
    const v = await judge.judge(p.text, p.candidates.slice(0, 3));
    tally[v.duplicate ? "duplicate" : "new"] += 1;
    costUsd += v.costUsd ?? 0;
    console.log(JSON.stringify({ id: p.id, verdict: v.duplicate ? "duplicate" : "new", of: v.of, costUsd: v.costUsd }));
  } catch (err) {
    tally[/without a verdict/.test(err.message) ? "noVerdict" : "otherError"] += 1;
    console.log(JSON.stringify({ id: p.id, verdict: "error", error: err.message }));
  }
}
console.log(JSON.stringify({ model, ...tally, noVerdictShare: tally.noVerdict / tally.calls, costUsd: Math.round(costUsd * 1e6) / 1e6 }));
