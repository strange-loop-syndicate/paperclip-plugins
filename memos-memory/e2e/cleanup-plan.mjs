// SLS-200 step 4: a keep / delete / merge list for every stored memory, by
// today's capture rules. Dry run: it deletes and changes nothing in MemOS.
// The re-judge runs in the plugin worker (it holds the extractor key)
// through the dry-run route. Subcommands dump | batches | report; usage and
// the full procedure: docs/sls-200-noise-fix.md.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [cmd, ...args] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const BATCH = 10;

function memoriesIn(x, out = []) {
  if (Array.isArray(x)) x.forEach((v) => memoriesIn(v, out));
  else if (x && typeof x === "object") {
    if (typeof x.memory === "string" && x.metadata) out.push(x);
    else Object.values(x).forEach((v) => memoriesIn(v, out));
  }
  return out;
}

// dump <memosUrl> <companyId> <out.json> <projectId>... ("unscoped" too)
async function dump([memosUrl, companyId, out, ...projectIds]) {
  const rows = [];
  for (const projectId of projectIds) {
    const body = { mem_cube_id: `paperclip-${companyId}-${projectId}`, user_id: `paperclip-${companyId}`, include_preference: false, include_tool_memory: false, include_skill_memory: false };
    const res = await fetch(`${memosUrl.replace(/\/+$/, "")}/product/get_memory`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const json = await res.json();
    if (json.code !== 200) throw new Error(`get_memory ${projectId}: ${json.code} ${json.message}`);
    for (const m of memoriesIn(json.data)) {
      const md = m.metadata;
      if (md.companyId && md.companyId !== companyId) continue;
      rows.push({ id: m.id ?? md.id, projectId, text: m.memory, kind: md.kind ?? null, createdAt: md.created_at ?? null, issueIdentifier: md.issueIdentifier ?? null, embedding: md.embedding ?? null });
    }
    console.error(`${projectId}: ${rows.filter((r) => r.projectId === projectId).length} memories`);
  }
  writeFileSync(out, JSON.stringify(rows));
}

/** The text sent for re-judging: with --path-user, the user name goes back where the provider wrote [PERSON_NAME] in a path. */
export function judgedText(text, pathUser) {
  if (!pathUser) return text;
  return text.replace(/\/Users\/\[PERSON_NAME\]\//g, `/Users/${pathUser}/`).replace(/bin\/\[PERSON_NAME\]\/\[PERSON_NAME\]/g, `bin/${pathUser}/${pathUser}`);
}

// batches <dump.json> <outDir> [--path-user claude]
function batches([dumpFile, outDir]) {
  const pathUser = flag("--path-user", null);
  const rows = JSON.parse(readFileSync(dumpFile, "utf8"));
  mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    n += 1;
    const memories = rows.slice(i, i + BATCH).map((r) => ({ id: r.id, text: judgedText(r.text, pathUser) }));
    writeFileSync(join(outDir, `batch-${String(n).padStart(3, "0")}.json`), JSON.stringify({ memories }));
  }
  console.log(`${rows.length} memories in ${n} batches`);
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

function readResults(dir) {
  const byId = new Map();
  for (const f of readdirSync(dir).filter((x) => x.startsWith("result-")).sort()) {
    const json = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const r of json.results ?? []) byId.set(r.id, r);
  }
  return byId;
}

const cell = (s, max = 220) => String(s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, max);

// report <dump.json> <resultsDir> <out.md> [--merge 0.85] [--projects file]:
// delete when the rules keep nothing, merge when a kept memory repeats an
// older kept one. --projects is a Paperclip project list, for cube names.
function report([dumpFile, resultsDir, out]) {
  const mergeAt = Number(flag("--merge", "0.85"));
  const projectsFile = flag("--projects", null);
  const listed = projectsFile ? JSON.parse(readFileSync(projectsFile, "utf8")) : [];
  const names = new Map((Array.isArray(listed) ? listed : (listed.projects ?? [])).map((p) => [p.id, p.name]));
  const label = (p) => (names.has(p) ? `${names.get(p)} (${p.slice(0, 8)})` : p);
  const rows = JSON.parse(readFileSync(dumpFile, "utf8")).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const results = readResults(resultsDir);
  const keepers = new Map(); // projectId -> kept rows, oldest first
  const plan = [];
  for (const row of rows) {
    const r = results.get(row.id);
    const redacted = /\[PERSON_NAME\]|\[IP_ADDRESS\]|\[ADDRESS\]/.test(row.text);
    if (!r || r.verdict === "error") {
      plan.push({ row, decision: "unjudged", reason: r?.error ?? "no dry-run answer; run its batch again" });
      continue;
    }
    if (r.verdict === "delete") {
      const reasons = [...new Set((r.dropped ?? []).map((d) => d.reason))];
      plan.push({ row, decision: "delete", reason: reasons.length ? `rules drop it: ${reasons.join(", ")}` : "the extractor keeps nothing: a task log, task status or one-task detail" });
      continue;
    }
    const same = (keepers.get(row.projectId) ?? []).map((k) => ({ k, sim: row.embedding && k.embedding ? cosine(row.embedding, k.embedding) : 0 })).sort((x, y) => y.sim - x.sim)[0];
    if (same && same.sim >= mergeAt) {
      plan.push({ row, decision: "merge", into: same.k.id, reason: `repeats ${same.k.id.slice(0, 8)} (cosine ${same.sim.toFixed(2)})` });
      continue;
    }
    if (!keepers.has(row.projectId)) keepers.set(row.projectId, []);
    keepers.get(row.projectId).push(row);
    const types = [...new Set((r.memories ?? []).map((m) => m.type))].join(", ");
    plan.push({ row, decision: "keep", reason: `durable ${types}${redacted ? "; restore the path user in the text" : ""}` });
  }

  const count = (d, p) => plan.filter((x) => x.decision === d && (!p || x.row.projectId === p)).length;
  const projects = [...new Set(rows.map((r) => r.projectId))];
  const lines = [
    "| Cube (project) | Memories | Keep | Delete | Merge | Unjudged |",
    "|---|---|---|---|---|---|",
    ...projects.map((p) => `| ${label(p)} | ${rows.filter((r) => r.projectId === p).length} | ${count("keep", p)} | ${count("delete", p)} | ${count("merge", p)} | ${count("unjudged", p)} |`),
    `| **All** | ${rows.length} | ${count("keep")} | ${count("delete")} | ${count("merge")} | ${count("unjudged")} |`,
    "",
  ];
  for (const p of projects) {
    lines.push(`### ${label(p)}`, "", "| Memory ID | Decision | Reason | Text |", "|---|---|---|---|");
    for (const x of plan.filter((y) => y.row.projectId === p)) lines.push(`| \`${x.row.id}\` | ${x.decision}${x.into ? ` → \`${x.into.slice(0, 8)}\`` : ""} | ${cell(x.reason, 120)} | ${cell(x.row.text)} |`);
    lines.push("");
  }
  writeFileSync(out, lines.join("\n"));
  writeFileSync(out.replace(/\.md$/, ".json"), JSON.stringify(plan.map((x) => ({ id: x.row.id, projectId: x.row.projectId, decision: x.decision, into: x.into ?? null, reason: x.reason, text: x.row.text }))));
  console.log(JSON.stringify({ memories: rows.length, keep: count("keep"), delete: count("delete"), merge: count("merge"), unjudged: count("unjudged") }));
}

if (cmd === "dump") await dump(args);
else if (cmd === "batches") batches(args);
else if (cmd === "report") report(args);
else {
  console.error("usage: cleanup-plan.mjs dump|batches|report …  (docs/sls-200-noise-fix.md)");
  process.exit(2);
}
