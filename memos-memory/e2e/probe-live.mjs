// SLS-63 live probe: does the plugin's MemOS client round-trip against the
// real server? Uses a throwaway probe company id, never a real one.
// Usage: node e2e/probe-live.mjs <baseUrl> <nonce>
import { createMemosClient } from "../src/memos-client.js";
import { scopeFor } from "../src/scope.js";

const [baseUrl = "http://127.0.0.1:8001", nonce = `probe-${Date.now()}`] = process.argv.slice(2);
const logs = [];
const logger = { warn: (...a) => logs.push(a) };
const client = createMemosClient({ baseUrl, logger });
const scope = scopeFor({ companyId: "e2e-probe-company", projectId: "e2e-probe-project" });

const content = `Decision: the SLS-63 probe codeword is ${nonce}.`;
let t = Date.now();
const add = await client.add({ scope, content, metadata: { kind: "decision", issueId: "probe-issue", runId: "probe-run" } });
console.log(JSON.stringify({ step: "add", ms: Date.now() - t, add, scope }));

for (const wait of [0, 3000, 10000]) {
  await new Promise((r) => setTimeout(r, wait));
  t = Date.now();
  const hits = await client.search({ scope, query: `SLS-63 probe codeword ${nonce}`, timeoutMs: 15000 });
  console.log(JSON.stringify({ step: "search", afterWaitMs: wait, ms: Date.now() - t, count: hits.length, hits }));
  if (hits.some((h) => h.content.includes(nonce))) break;
}
console.log(JSON.stringify({ warnings: logs }));
