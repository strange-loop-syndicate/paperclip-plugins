// SLS-63 live probe: after the async rewrite, is the probe memory still in
// its own scope, with metadata, and absent from other scopes?
// Usage: node e2e/probe-scope.mjs <baseUrl> <nonce>
import { createMemosClient } from "../src/memos-client.js";
import { scopeFor } from "../src/scope.js";

const [baseUrl = "http://127.0.0.1:8001", nonce] = process.argv.slice(2);
const client = createMemosClient({ baseUrl, logger: { warn: (...a) => console.log("WARN", JSON.stringify(a)) } });
const query = `SLS-63 probe codeword ${nonce}`;
const scopes = {
  own: scopeFor({ companyId: "e2e-probe-company", projectId: "e2e-probe-project" }),
  otherProject: scopeFor({ companyId: "e2e-probe-company", projectId: "e2e-other-project" }),
  otherCompany: scopeFor({ companyId: "e2e-other-company", projectId: "e2e-probe-project" }),
};
for (const [name, scope] of Object.entries(scopes)) {
  const t = Date.now();
  const hits = await client.search({ scope, query, timeoutMs: 15000 });
  const pick = hits.map((h) => ({ content: h.content, memory_type: h.metadata.memory_type, tags: h.metadata.tags, companyId: h.metadata.companyId, issueId: h.metadata.issueId, runId: h.metadata.runId, relativity: h.metadata.relativity }));
  console.log(JSON.stringify({ scope: name, cube: scope.cubeId, ms: Date.now() - t, count: hits.length, nonceFound: hits.some((h) => h.content.includes(nonce)), hits: pick }));
}
