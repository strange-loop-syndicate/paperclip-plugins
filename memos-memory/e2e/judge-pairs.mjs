// SLS-206 probe: run this checkout's duplicate judge on saved pairs and count
// the verdicts. Stores nothing and reads no MemOS. One judge call per pair.
// Usage: OPENROUTER_API_KEY=… node e2e/judge-pairs.mjs <pairs.json> [model] [baseUrl]
// <pairs.json> is a list of { id, text, candidates: [text, …] } (1 to 3), the
// shape of the dry-run route's `duplicates` body. An optional `expect`
// ("duplicate" or "new", a hand grade) is compared with the verdict, and the
// summary counts the misses (SLS-208). The key is never printed.
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
const graded = { graded: 0, agree: 0, missedDuplicates: [], wrongDuplicates: [] };
let costUsd = 0;
for (const p of pairs) {
  tally.calls += 1;
  try {
    const v = await judge.judge(p.text, p.candidates.slice(0, 3));
    const verdict = v.duplicate ? "duplicate" : "new";
    tally[verdict] += 1;
    costUsd += v.costUsd ?? 0;
    if (p.expect === "duplicate" || p.expect === "new") {
      graded.graded += 1;
      if (verdict === p.expect) graded.agree += 1;
      else (p.expect === "duplicate" ? graded.missedDuplicates : graded.wrongDuplicates).push(p.id);
    }
    console.log(JSON.stringify({ id: p.id, verdict, ...(p.expect ? { expect: p.expect } : {}), of: v.of, costUsd: v.costUsd }));
  } catch (err) {
    tally[/without a verdict/.test(err.message) ? "noVerdict" : "otherError"] += 1;
    console.log(JSON.stringify({ id: p.id, verdict: "error", error: err.message }));
  }
}
console.log(JSON.stringify({ model, ...tally, noVerdictShare: tally.noVerdict / tally.calls, costUsd: Math.round(costUsd * 1e6) / 1e6, ...(graded.graded ? graded : {}) }));
