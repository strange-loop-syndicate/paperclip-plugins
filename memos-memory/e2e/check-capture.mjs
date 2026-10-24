// SLS-63 E2E: list what MemOS holds for a nonce in one company + project
// scope, with the capture metadata. Read-only.
// Usage: node e2e/check-capture.mjs <baseUrl> <companyId> <projectId> <nonce>
import { createMemosClient } from "../src/memos-client.js";
import { scopeFor } from "../src/scope.js";

const [baseUrl, companyId, projectId, nonce] = process.argv.slice(2);
if (!nonce) {
  console.error("usage: check-capture.mjs <baseUrl> <companyId> <projectId> <nonce>");
  process.exit(2);
}
const client = createMemosClient({ baseUrl, logger: { warn: (...a) => console.log("WARN", JSON.stringify(a)) } });
const scope = scopeFor({ companyId, projectId });
const t = Date.now();
const hits = await client.search({ scope, query: `Memory E2E project codeword ${nonce}`, topK: 20, timeoutMs: 15000 });
const matching = hits.filter((h) => h.content.includes(nonce));
const pick = (h) => {
  const m = h.metadata;
  return {
    content: h.content,
    kind: m.kind,
    companyId: m.companyId,
    projectId: m.projectId,
    agentId: m.agentId,
    issueId: m.issueId,
    issueIdentifier: m.issueIdentifier,
    runId: m.runId,
    contentHash: m.contentHash,
    source: m.source,
    relativity: m.relativity,
  };
};
console.log(JSON.stringify({ cube: scope.cubeId, ms: Date.now() - t, totalHits: hits.length, nonceHits: matching.length, hits: matching.map(pick) }, null, 2));
