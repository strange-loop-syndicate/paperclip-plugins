// SLS-99 step 1: does a sync `fine` add keep our `info` IDs on every memory
// MemReader extracts? Also records memory types, length, time per add,
// `info` / `custom_tags` as search filters, and dedup on a repeat add.
// Uses a throwaway probe company id, never a real one.
// Usage: node e2e/probe-fine.mjs <baseUrl> <nonce>

const [baseUrl = "http://127.0.0.1:8001", nonce = `fine-${Date.now()}`] = process.argv.slice(2);
const companyId = "e2e-probe-company";
const projectId = `e2e-fine-${nonce}`;
const userId = `paperclip-${companyId}`;
const cubeId = `paperclip-${companyId}-${projectId}`;
const info = { companyId, projectId, issueId: `issue-${nonce}`, issueIdentifier: "PRB-1", runId: `run-${nonce}`, commentId: `comment-${nonce}`, agentId: "agent-probe", kind: "decision", source: "issue.comment.created" };

// A realistic agent comment: one decision, one lesson, routine status.
const comment = `Status: tests pass, moving to review.

We decided to keep the ${nonce} queue in plugin state instead of a new table, because the host already persists plugin state per company.

Lesson: the MemOS async add drops add-time info, so ${nonce} captures must use sync mode.

Next I will open the PR.`;

async function post(path, body, timeoutMs = 120000) {
  const t = Date.now();
  const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const json = await res.json().catch(() => null);
  return { ms: Date.now() - t, status: res.status, json };
}

const pickMemory = (m) => ({
  memory: m.memory,
  chars: m.memory?.length,
  memory_type: m.metadata?.memory_type,
  type: m.metadata?.type,
  tags: m.metadata?.tags,
  info: m.metadata?.info,
  topLevelIds: Object.fromEntries(Object.keys(info).map((k) => [k, m.metadata?.[k]])),
});

function searchItems(json) {
  const out = [];
  for (const b of json?.data?.text_mem ?? []) out.push(...(b.memories ?? []));
  return out;
}

const addBody = {
  user_id: userId,
  mem_cube_id: cubeId,
  messages: [{ role: "assistant", content: comment, chat_time: new Date().toISOString() }],
  async_mode: "sync",
  mode: "fine",
  custom_tags: ["paperclip", `kind:${info.kind}`],
  info,
};

const add1 = await post("/product/add", addBody);
console.log(JSON.stringify({ step: "fine add", ms: add1.ms, status: add1.status, code: add1.json?.code, message: add1.json?.message, data: add1.json?.data }, null, 2));

const search = async (label, extra = {}) => {
  const r = await post("/product/search", { query: `${nonce} queue plugin state sync mode`, user_id: userId, mem_cube_id: cubeId, top_k: 20, ...extra }, 30000);
  const items = searchItems(r.json).filter((m) => String(m.memory).includes(nonce) || JSON.stringify(m.metadata ?? {}).includes(nonce));
  console.log(JSON.stringify({ step: label, ms: r.ms, status: r.status, code: r.json?.code, message: r.json?.message, count: items.length, items: items.map(pickMemory) }, null, 2));
  return items;
};

await search("search, no filter");
await search("search, filter info.runId", { filter: { and: [{ runId: info.runId }] } });
await search("search, filter wrong runId", { filter: { and: [{ runId: "run-nope" }] } });
await search("search, filter info.companyId", { filter: { and: [{ companyId }] } });
await search("search, filter tag", { filter: { and: [{ tags: { contains: `kind:${info.kind}` } }] } });

const add2 = await post("/product/add", addBody);
console.log(JSON.stringify({ step: "repeat fine add (dedup?)", ms: add2.ms, status: add2.status, code: add2.json?.code, data: add2.json?.data }, null, 2));
await search("search after repeat add");
