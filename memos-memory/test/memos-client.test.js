import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { normalizeContent } from "../src/content.js";
import { createMemosClient, parseSearchResponse, recallAcrossScopes } from "../src/memos-client.js";
import { scopeFor } from "../src/scope.js";
import { deadUrl, seedMemory, startFakeServer } from "./helpers/fake-servers.js";

const scope = scopeFor({ companyId: "company-a", projectId: "p1" });

function collectingLogger() {
  const warnings = [];
  return { warnings, warn: (msg) => warnings.push(msg) };
}

describe("MemOS client", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => {
    server.state.mode = "ok";
    server.state.store.length = 0;
    server.state.requests.length = 0;
  });

  it("round-trips a memory through add and search", async () => {
    const client = createMemosClient({ baseUrl: server.url, logger: collectingLogger() });
    assert.deepEqual(await client.add({ scope, content: "remember this", metadata: { kind: "note" } }), { ok: true });
    const found = await client.search({ scope, query: "remember" });
    assert.equal(found.length, 1);
    assert.equal(found[0].content, "remember this");
    assert.equal(found[0].metadata.kind, "note");
  });

  it("adds in sync fast mode, so MemOS keeps the text and its info", async () => {
    await createMemosClient({ baseUrl: server.url }).add({ scope, content: "c" });
    const [req] = server.memosRequests();
    assert.equal(req.body.async_mode, "sync");
    assert.equal(req.body.mode, "fast");
    assert.equal(req.body.info.companyId, "company-a");
  });

  it("drops results with no company field, such as an async-rewritten memory", async () => {
    server.state.store.push({ userId: scope.userId, cubeId: scope.cubeId, content: "rewritten, info lost", info: {} });
    seedMemory(server.state, { companyId: "company-a", projectId: "p1", content: "own memory" });
    const found = await createMemosClient({ baseUrl: server.url }).search({ scope, query: "q" });
    assert.deepEqual(found.map((m) => m.content), ["own memory"]);
  });

  it("sends the bearer token only when configured", async () => {
    await createMemosClient({ baseUrl: server.url, apiKey: "tok" }).search({ scope, query: "q" });
    await createMemosClient({ baseUrl: server.url }).search({ scope, query: "q" });
    const [withKey, without] = server.memosRequests();
    assert.equal(withKey.headers.authorization, "Bearer tok");
    assert.equal(without.headers.authorization, undefined);
  });

  for (const [name, prepare] of [
    ["server down", async () => ({ baseUrl: await deadUrl() })],
    ["HTTP 500", async () => ((server.state.mode = "error500"), { baseUrl: server.url })],
    ["slow server", async () => ((server.state.mode = "slow"), { baseUrl: server.url })],
  ]) {
    it(`${name}: search returns [] and add returns ok:false, without throwing, and warns`, async () => {
      const logger = collectingLogger();
      const client = createMemosClient({ ...(await prepare()), logger });
      const t0 = Date.now();
      assert.deepEqual(await client.search({ scope, query: "q", timeoutMs: 300 }), []);
      assert.equal((await client.add({ scope, content: "c", timeoutMs: 300 })).ok, false);
      assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
      assert.equal(logger.warnings.length, 2);
    });
  }

  it("treats a MemOS error code inside a 200 response as a failure", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ code: 500, message: "cube not found" }), { status: 200 });
    const logger = collectingLogger();
    assert.deepEqual(await createMemosClient({ baseUrl: "http://x", fetchImpl, logger }).search({ scope, query: "q" }), []);
    assert.match(logger.warnings[0], /cube not found/);
  });

  it("is a no-op when no base URL is configured", async () => {
    const client = createMemosClient({ baseUrl: "" });
    assert.equal(client.configured, false);
    assert.deepEqual(await client.search({ scope, query: "q" }), []);
  });

  it("recallAcrossScopes keeps own scope first, removes duplicates and caps at topK", async () => {
    seedMemory(server.state, { companyId: "company-a", projectId: "p1", content: "Own lesson" });
    seedMemory(server.state, { companyId: "company-a", projectId: "p2", content: "own  LESSON." });
    seedMemory(server.state, { companyId: "company-a", projectId: "p2", content: "Shared lesson" });
    const client = createMemosClient({ baseUrl: server.url });
    const scopes = [scope, scopeFor({ companyId: "company-a", projectId: "p2" })];
    const all = await recallAcrossScopes({ client, scopes, query: "q", topK: 5, normalize: normalizeContent });
    assert.deepEqual(all.map((m) => m.content), ["Own lesson", "Shared lesson"]);
    const one = await recallAcrossScopes({ client, scopes, query: "q", topK: 1, normalize: normalizeContent });
    assert.equal(one.length, 1);
  });
});

describe("search response parsing", () => {
  it("accepts the known MemOS shapes", () => {
    assert.deepEqual(parseSearchResponse({ data: { text_mem: [{ memories: [{ memory: "a", metadata: { kind: "x" } }] }] } }), [{ content: "a", metadata: { kind: "x" } }]);
    assert.deepEqual(parseSearchResponse({ data: { memories: ["b"] } }), [{ content: "b", metadata: {} }]);
    assert.deepEqual(parseSearchResponse({ data: [{ memory_content: "c", info: { kind: "y" } }] }), [{ content: "c", metadata: { kind: "y" } }]);
    assert.deepEqual(parseSearchResponse({ data: null }), []);
  });
});
