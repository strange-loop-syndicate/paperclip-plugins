import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createMemoryPlugin, RETRY_JOB_KEY, SECRET_RETRY_MS, SECRET_TTL_MS } from "../src/plugin.js";
import { fakeHostSecrets, RATE_LIMIT, secretRef } from "./helpers/fake-secrets.js";
import { deadUrl, seedMemory, startFakeServer } from "./helpers/fake-servers.js";

const A = "company-a";
const B = "company-b";
const BODY = "We decided to run pre-prompt recall in a command wrapper.\n\n```js\nconst secret = 'CODE-ONLY-TOKEN';\n```\n\nTests pass.";

const issue = (over = {}) => ({ id: "iss-1", companyId: A, projectId: "p1", identifier: "SLS-1", title: "Build memory", status: "in_progress", ...over });
const project = (id, name, companyId = A) => ({ id, companyId, name, archivedAt: null });
const comment = (over = {}) => ({
  id: "c-1",
  companyId: A,
  issueId: "iss-1",
  authorType: "agent",
  authorAgentId: "agent-1",
  authorUserId: null,
  createdByRunId: "run-1",
  body: BODY,
  presentation: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function commentEvent(over = {}, payload = {}) {
  return [
    { commentId: "c-1", bodySnippet: "…", identifier: "SLS-1", agentId: "agent-1", runId: "run-1", ...payload },
    { companyId: A, actorType: "agent", actorId: "agent-1", entityId: "iss-1", entityType: "issue", eventId: "evt-1", ...over },
  ];
}
const boardEvent = (commentId = "c-board") => commentEvent({ actorType: "user", actorId: "user-1", eventId: `evt-${commentId}` }, { commentId, agentId: null, runId: null });

function clock(start = Date.parse("2026-10-24T10:00:00Z")) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

const OR_SECRET = "0b8f3d4e-6a1c-4f2b-9c7d-1e2f3a4b5c6d";
const MEMOS_SECRET = "7c9e1a2b-3d4f-4a5b-8c6d-9e0f1a2b3c4d";
const OR_KEY = "sk-or-test-key";
const boundSecrets = (now) =>
  fakeHostSecrets({ now, bindings: [{ companyId: A, secretId: OR_SECRET, configPath: "openrouterApiKeyRef" }], values: { [OR_SECRET]: OR_KEY } });

async function setup(server, config = {}, seed = {}, { now, secrets = boundSecrets(now) } = {}) {
  const harness = createTestHarness({
    manifest,
    config: {
      memosBaseUrl: server.url,
      openrouterBaseUrl: server.url,
      openrouterApiKeyRef: secretRef(OR_SECRET),
      captureMode: "save",
      recallTimeoutMs: 500,
      captureTimeoutMs: 500,
      jevTimeoutMs: 500,
      extractTimeoutMs: 500,
      ...config,
    },
  });
  harness.seed({ issues: [issue()], issueComments: [comment()], projects: [project("p1", "Memory"), project("p2", "Ops")], ...seed });
  // The SDK harness resolves any string; the real host does not.
  harness.ctx.secrets = secrets;
  harness.secrets = secrets;
  const plugin = createMemoryPlugin({ now, sleep: async () => {} });
  await plugin.definition.setup(harness.ctx);
  harness.plugin = plugin;
  return harness;
}

const adds = (server) => server.memosRequests().filter((r) => r.path === "/product/add");
const jevCalls = (server) => server.llmRequests("/systemone");
const extractCalls = (server) => server.llmRequests("/chat/completions");
const runCtx = (over = {}) => ({ agentId: "agent-1", runId: "run-9", companyId: A, projectId: "p1", ...over });
const pendingOf = (h) => h.getState({ scopeKind: "instance", namespace: "memos-pending", stateKey: "queue" }) ?? [];
const api = (h, routeKey, query, companyId = A) => h.plugin.definition.onApiRequest({ routeKey, method: "GET", path: `/${routeKey}`, params: {}, query, body: null, actor: { actorType: "agent", actorId: "agent-1" }, companyId, headers: {} });

function resetServer(server) {
  server.state.mode = "ok";
  server.state.store.length = 0;
  server.state.requests.length = 0;
  server.state.llm.mode = "ok";
  server.state.llm.chatMode = "ok";
  server.state.llm.answers = { decision: 0.9, lesson: 0.1, outcome: 0.2, fact: 0.1, routine: 0.1 };
  server.state.llm.memories = [{ type: "decision", text: "Pre-prompt recall runs in a command wrapper, not a plugin hook." }];
}

describe("capture: Jev gate and extraction", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => resetServer(server));

  it("stores the extracted short memory, never the comment text, with every ID", async () => {
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    const stored = adds(server).map((r) => r.body);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].memory_content, "Pre-prompt recall runs in a command wrapper, not a plugin hook.");
    assert.notEqual(stored[0].memory_content, BODY);
    assert.equal(stored[0].mode, "fast");
    assert.equal(stored[0].mem_cube_id, `paperclip-${A}-p1`);
    const info = stored[0].info;
    for (const key of ["companyId", "projectId", "agentId", "issueId", "issueIdentifier", "commentId", "runId", "kind", "contentHash"]) {
      assert.ok(info[key], `metadata.${key} is set`);
    }
    assert.equal(info.kind, "decision");
    assert.equal(info.commentId, "c-1");
    assert.equal(info.authorType, "agent");
  });

  it("captures board comments too, attributed to the board user", async () => {
    const h = await setup(server, {}, { issueComments: [comment({ id: "c-board", authorType: "user", authorAgentId: null, authorUserId: "user-1", createdByRunId: null })] });
    await h.emit("issue.comment.created", ...boardEvent());
    const stored = adds(server).map((r) => r.body);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].info.authorType, "user");
    assert.equal(stored[0].info.userId, "user-1");
    assert.equal(stored[0].info.commentId, "c-board");
    assert.equal(jevCalls(server)[0].body.state.item.source, "board comment");
  });

  it("cuts code blocks before Jev and the extractor see the text", async () => {
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    const sent = JSON.stringify([jevCalls(server)[0].body, extractCalls(server)[0].body]);
    assert.doesNotMatch(sent, /CODE-ONLY-TOKEN/);
    assert.match(jevCalls(server)[0].body.state.item.text, /command wrapper/);
    assert.equal(jevCalls(server)[0].body.model, "typesafe/jev-1.13");
  });

  it("skips an item below saveP without calling the extractor", async () => {
    server.state.llm.answers = { decision: 0.69, lesson: 0.2, outcome: 0.3, fact: 0.4, routine: 0.1 };
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(jevCalls(server).length, 1);
    assert.equal(extractCalls(server).length, 0);
    assert.equal(adds(server).length, 0);
  });

  it("skips routine status even when a content question is high", async () => {
    server.state.llm.answers = { decision: 0.95, lesson: 0.1, outcome: 0.1, fact: 0.1, routine: 0.6 };
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(extractCalls(server).length, 0);
    assert.equal(adds(server).length, 0);
  });

  it("honours a configured saveP", async () => {
    server.state.llm.answers = { decision: 0.6, lesson: 0.1, outcome: 0.1, fact: 0.1, routine: 0.1 };
    const h = await setup(server, { saveP: 0.55 });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 1);
  });

  it("an empty extraction saves nothing", async () => {
    server.state.llm.memories = [];
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 0);
  });

  it("is idempotent across redelivery and the run event for the same comment", async () => {
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    await h.emit("issue.comment.created", ...commentEvent({ eventId: "evt-again" }));
    await h.emit("agent.run.finished", { runId: "run-1", agentId: "agent-1", issueId: "iss-1" }, { companyId: A, actorType: "agent" });
    assert.equal(jevCalls(server).length, 1);
    assert.equal(adds(server).length, 1);
  });

  it("is idempotent across concurrent redelivery", async () => {
    const h = await setup(server);
    await Promise.all([h.emit("issue.comment.created", ...commentEvent()), h.emit("issue.comment.created", ...commentEvent({ eventId: "evt-2" }))]);
    assert.equal(jevCalls(server).length, 1);
    assert.equal(adds(server).length, 1);
  });

  it("gates the run's newest agent comment as its result", async () => {
    const old = comment({ id: "c-old", body: "Older note from the same run, long enough to count.", createdAt: new Date("2026-01-01T00:00:00Z") });
    const last = comment({ id: "c-last", body: "Final result: the wrapper ships and recall works in Codex.", createdAt: new Date("2026-01-01T00:05:00Z") });
    const h = await setup(server, { captureComments: false }, { issueComments: [last, old] });
    await h.emit("agent.run.finished", { runId: "run-1", agentId: "agent-1", issueId: "iss-1" }, { companyId: A, actorType: "agent" });
    assert.equal(jevCalls(server).length, 1);
    assert.match(jevCalls(server)[0].body.state.item.text, /Final result/);
    assert.equal(jevCalls(server)[0].body.state.item.source, "run result");
    assert.equal(adds(server)[0].body.info.commentId, "c-last");
    assert.equal(adds(server)[0].body.info.source, "agent.run.finished");
  });

  it("dedups the same extracted memory per scope", async () => {
    const h = await setup(server, {}, { issueComments: [comment(), comment({ id: "c-2" })] });
    await h.emit("issue.comment.created", ...commentEvent());
    await h.emit("issue.comment.created", ...commentEvent({ eventId: "evt-c2" }, { commentId: "c-2" }));
    assert.equal(jevCalls(server).length, 2);
    assert.equal(adds(server).length, 1);
  });

  it("keeps at most three memories per item and drops malformed ones", async () => {
    server.state.llm.memories = [
      { type: "decision", text: "First decision about the wrapper path." },
      { type: "bogus", text: "A fact with an unknown type label." },
      { type: "lesson", text: "x" },
      { type: "outcome", text: "The import landed in memos-memory/." },
      { type: "fact", text: "A fourth memory that must be cut." },
    ];
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    const stored = adds(server).map((r) => [r.body.info.kind, r.body.memory_content]);
    assert.deepEqual(stored.map(([k]) => k).sort(), ["decision", "fact", "outcome"]);
  });

  it("does nothing without an OpenRouter key", async () => {
    const h = await setup(server, { openrouterApiKeyRef: "" });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(jevCalls(server).length, 0);
    assert.equal(adds(server).length, 0);
  });

  it("ignores system comments", async () => {
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent({ actorType: "system", actorId: "sys" }));
    assert.equal(jevCalls(server).length, 0);
  });

  it("captureProjectIds limits capture and retain to the listed projects", async () => {
    const off = await setup(server, { captureProjectIds: ["p-other"] });
    await off.emit("issue.comment.created", ...commentEvent());
    const r = await off.executeTool("memory_retain", { content: "Off-project retain" }, runCtx());
    assert.equal(r.data.status, "rejected");
    assert.equal(jevCalls(server).length, 0);
    const on = await setup(server, { captureProjectIds: ["p1"] });
    await on.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 1);
  });

  it("never uses an issue from another company, even if the host returns one", async () => {
    const h = await setup(server, {}, { issues: [issue({ companyId: B })] });
    await h.emit("issue.comment.created", ...commentEvent());
    await h.emit("agent.run.finished", { runId: "run-1", agentId: "agent-1", issueId: "iss-1" }, { companyId: A, actorType: "agent" });
    assert.equal(jevCalls(server).length, 0);
    assert.equal(adds(server).length, 0);
  });
});

describe("secrets: the host's secret_ref contract", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => resetServer(server));

  const comments = (n) => Array.from({ length: n }, (_, i) => comment({ id: `c-${i}` }));
  const emitComment = (h, i, companyId = A) => h.emit("issue.comment.created", ...commentEvent({ eventId: `evt-${companyId}-${i}-${Math.random()}`, companyId }, { commentId: `c-${i}` }));

  it("the fake host refuses what the real one refuses", async () => {
    const s = boundSecrets();
    await assert.rejects(s.resolve("openrouter-key", { companyId: A }), /Invalid secret reference/);
    await assert.rejects(s.resolve(OR_SECRET, { companyId: A }), /Invalid secret reference/);
    await assert.rejects(s.resolve(secretRef(OR_SECRET)), /companyId is required/);
    await assert.rejects(s.resolve(secretRef(OR_SECRET), { companyId: B }), /not bound/);
    await assert.rejects(s.resolve(secretRef(OR_SECRET), { companyId: A, configPath: "memosApiKeyRef" }), /not bound/);
    assert.equal(await s.resolve(secretRef(OR_SECRET), { companyId: A, configPath: "openrouterApiKeyRef" }), OR_KEY);
  });

  it("both key fields are secret pickers in the settings form", () => {
    for (const field of ["openrouterApiKeyRef", "memosApiKeyRef"]) {
      assert.equal(manifest.instanceConfigSchema.properties[field].format, "secret-ref");
      assert.equal(manifest.instanceConfigSchema.properties[field].type, "object");
    }
  });

  it("resolves the binding with the company and config path, and Jev gets the key", async () => {
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    assert.deepEqual(h.secrets.calls.map((c) => [c.ref, c.options]), [[secretRef(OR_SECRET), { companyId: A, configPath: "openrouterApiKeyRef" }]]);
    assert.equal(jevCalls(server)[0].headers.authorization, `Bearer ${OR_KEY}`);
    assert.equal(extractCalls(server)[0].headers.authorization, `Bearer ${OR_KEY}`);
    assert.equal(adds(server).length, 1);
  });

  it("a bound MemOS token reaches MemOS as a bearer token", async () => {
    const secrets = fakeHostSecrets({
      bindings: [
        { companyId: A, secretId: OR_SECRET, configPath: "openrouterApiKeyRef" },
        { companyId: A, secretId: MEMOS_SECRET, configPath: "memosApiKeyRef" },
      ],
      values: { [OR_SECRET]: OR_KEY, [MEMOS_SECRET]: "memos-token" },
    });
    const h = await setup(server, { memosApiKeyRef: secretRef(MEMOS_SECRET) }, {}, { secrets });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server)[0].headers.authorization, "Bearer memos-token");
  });

  it("a plain string ref captures nothing and says how to fix it", async () => {
    const h = await setup(server, { openrouterApiKeyRef: "openrouter-key" });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(jevCalls(server).length, 0);
    assert.equal(adds(server).length, 0);
    assert.ok(h.logs.some((l) => /not a secret binding/.test(l.message)));
  });

  it("a secret bound in another company is never resolved for this one", async () => {
    const h = await setup(server, {}, { issues: [issue({ companyId: B })], issueComments: [comment({ companyId: B })], projects: [project("p1", "Memory", B)] });
    await h.emit("issue.comment.created", ...commentEvent({ companyId: B }));
    assert.equal(h.secrets.calls[0].options.companyId, B);
    assert.equal(jevCalls(server).length, 0);
  });

  it("caches the key: 40 events in a minute make one resolve and stay under the host limit", async () => {
    const now = clock();
    const h = await setup(server, {}, { issueComments: comments(40) }, { now });
    for (let i = 0; i < 40; i++) await emitComment(h, i);
    assert.equal(h.secrets.calls.length, 1);
    assert.ok(40 > RATE_LIMIT);
    assert.equal(jevCalls(server).length, 40);
    assert.ok(!h.logs.some((l) => /could not be resolved/.test(l.message)));
  });

  it("concurrent events share one in-flight resolve", async () => {
    const h = await setup(server, {}, { issueComments: comments(5) });
    await Promise.all([0, 1, 2, 3, 4].map((i) => emitComment(h, i)));
    assert.equal(h.secrets.calls.length, 1);
    assert.equal(jevCalls(server).length, 5);
  });

  it("the cache is per company", async () => {
    const secrets = fakeHostSecrets({
      bindings: [
        { companyId: A, secretId: OR_SECRET, configPath: "openrouterApiKeyRef" },
        { companyId: B, secretId: OR_SECRET, configPath: "openrouterApiKeyRef" },
      ],
      values: { [OR_SECRET]: OR_KEY },
    });
    const h = await setup(server, {}, { issueComments: [comment(), comment({ id: "c-b", companyId: B })] }, { secrets });
    await h.emit("issue.comment.created", ...commentEvent());
    await h.emit("issue.comment.created", ...commentEvent({ companyId: B, eventId: "evt-b" }, { commentId: "c-b" }));
    assert.deepEqual(secrets.calls.map((c) => c.options.companyId), [A, B]);
  });

  it("a config save drops that company's cached key, so a rotated key is used", async () => {
    const h = await setup(server, {}, { issueComments: comments(3) });
    await emitComment(h, 0);
    h.secrets.values[OR_SECRET] = "sk-or-rotated";
    await h.plugin.definition.onConfigChanged({}, { companyId: B });
    await emitComment(h, 1);
    assert.equal(h.secrets.calls.length, 1, "another company's save keeps this cache");
    assert.equal(jevCalls(server).at(-1).headers.authorization, `Bearer ${OR_KEY}`);
    await h.plugin.definition.onConfigChanged({}, { companyId: A });
    await emitComment(h, 2);
    assert.equal(h.secrets.calls.length, 2);
    assert.equal(jevCalls(server).at(-1).headers.authorization, "Bearer sk-or-rotated");
  });

  it("the cached key expires after the TTL", async () => {
    const now = clock();
    const h = await setup(server, {}, { issueComments: comments(2) }, { now });
    await emitComment(h, 0);
    now.advance(SECRET_TTL_MS + 1);
    await emitComment(h, 1);
    assert.equal(h.secrets.calls.length, 2);
  });

  it("a failed resolve is retried after a minute, not on every event", async () => {
    const now = clock();
    const secrets = fakeHostSecrets({ now, bindings: [], values: { [OR_SECRET]: OR_KEY } });
    const h = await setup(server, {}, { issueComments: comments(3) }, { now, secrets });
    await emitComment(h, 0);
    await emitComment(h, 1);
    assert.equal(secrets.calls.length, 1);
    assert.equal(jevCalls(server).length, 0);
    assert.ok(h.logs.some((l) => /could not be resolved/.test(l.message)));
    secrets.bindings.push({ companyId: A, secretId: OR_SECRET, configPath: "openrouterApiKeyRef" });
    now.advance(SECRET_RETRY_MS + 1);
    await emitComment(h, 2);
    assert.equal(secrets.calls.length, 2);
    assert.equal(jevCalls(server).length, 1);
  });

  it("serves several companies from one worker", () => {
    assert.equal(createMemoryPlugin().definition.multiCompanyConfig, true);
  });
});

describe("capture: shadow mode", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => resetServer(server));

  it("is the default: logs verdicts and extracted memories, saves nothing", async () => {
    const now = clock();
    const h = await setup(server, { captureMode: undefined }, { issueComments: [comment(), comment({ id: "c-2" })] }, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    server.state.llm.answers = { decision: 0.1, lesson: 0.1, outcome: 0.1, fact: 0.1, routine: 0.9 };
    await h.emit("issue.comment.created", ...commentEvent({ eventId: "evt-c2" }, { commentId: "c-2" }));
    assert.equal(adds(server).length, 0);
    const res = await api(h, "shadow-log", { date: "2026-10-24" });
    assert.equal(res.status, 200);
    const verdicts = res.body.entries.map((e) => [e.commentId, e.verdict]);
    assert.deepEqual(verdicts, [["c-1", "pass"], ["c-2", "skip"]]);
    const pass = res.body.entries[0];
    assert.deepEqual(pass.memories, [{ type: "decision", content: "Pre-prompt recall runs in a command wrapper, not a plugin hook." }]);
    assert.equal(pass.type, "decision");
    assert.equal(pass.jevCostUsd, 0.0001);
    assert.equal(pass.extractCostUsd, 0.0002);
    assert.ok(pass.probs.decision >= 0.9);
    assert.doesNotMatch(JSON.stringify(res.body), /Tests pass/, "the shadow log holds no comment text");
  });

  it("the shadow log is per company", async () => {
    const now = clock();
    const h = await setup(server, { captureMode: "shadow" }, {}, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    const other = await api(h, "shadow-log", { date: "2026-10-24" }, B);
    assert.deepEqual(other.body.entries, []);
  });
});

describe("capture: outages wait in a retry queue", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => resetServer(server));

  it("Jev down: the item waits with IDs only, and the retry job stores it later", async () => {
    const now = clock();
    server.state.llm.mode = "error500";
    const h = await setup(server, {}, {}, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 0);
    const queue = pendingOf(h);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].commentId, "c-1");
    assert.doesNotMatch(JSON.stringify(queue), /command wrapper/, "the queue holds no comment text");
    assert.equal(jevCalls(server).length, 3, "three tries");

    server.state.llm.mode = "ok";
    await h.runJob(RETRY_JOB_KEY);
    assert.equal(adds(server).length, 0, "not due yet");
    now.advance(11 * 60 * 1000);
    await h.runJob(RETRY_JOB_KEY);
    assert.equal(adds(server).length, 1);
    assert.equal(pendingOf(h).length, 0);
  });

  it("extractor down: the item waits", async () => {
    server.state.llm.chatMode = "error503";
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(extractCalls(server).length, 3, "three tries");
    assert.equal(adds(server).length, 0);
    assert.equal(pendingOf(h).length, 1);
    assert.match(pendingOf(h)[0].lastError, /extractor/);
  });

  it("drops an item after 24 h of retries", async () => {
    const now = clock();
    server.state.llm.mode = "error500";
    const h = await setup(server, {}, {}, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(pendingOf(h).length, 1);
    now.advance(24 * 60 * 60 * 1000 + 1);
    await h.runJob(RETRY_JOB_KEY);
    assert.equal(pendingOf(h).length, 0);
    assert.ok(h.logs.some((l) => /dropped after 24 h/.test(l.message)));
  });

  it("MemOS down in save mode: the item waits and is not marked done", async () => {
    const now = clock();
    server.state.mode = "error500";
    const h = await setup(server, {}, {}, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(pendingOf(h).length, 1);
    server.state.mode = "ok";
    now.advance(11 * 60 * 1000);
    await h.runJob(RETRY_JOB_KEY);
    assert.equal(server.state.store.length, 1);
    assert.equal(pendingOf(h).length, 0);
  });

  it("a bad key fails fast without retries and waits", async () => {
    server.state.llm.mode = "error401";
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(jevCalls(server).length, 1);
    assert.equal(pendingOf(h).length, 1);
  });
});

describe("plugin tools and sharing", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => {
    resetServer(server);
    seedMemory(server.state, { companyId: A, projectId: "p1", content: "Own project outcome", info: { kind: "outcome" } });
    seedMemory(server.state, { companyId: A, projectId: "p1", content: "Own project lesson", info: { kind: "lesson" } });
    seedMemory(server.state, { companyId: A, projectId: "p2", content: "Shared project decision", info: { kind: "decision", issueIdentifier: "OPS-3" } });
    seedMemory(server.state, { companyId: B, projectId: "p1", content: "Company B memory" });
  });

  const board = { actor: { type: "user", userId: "user-1" }, companyId: A };

  it("memory_recall reads only the caller's company + project by default", async () => {
    const h = await setup(server);
    const r = await h.executeTool("memory_recall", { query: "anything" }, runCtx());
    assert.deepEqual(r.data.memories.map((m) => m.content), ["Own project lesson", "Own project outcome"]);
  });

  it("recall puts decisions and lessons before outcomes and facts", async () => {
    const h = await setup(server);
    await h.performAction("save-sharing", { shares: [{ projectId: "p2", readers: ["p1"] }] }, board);
    const r = await h.executeTool("memory_recall", { query: "anything" }, runCtx());
    assert.deepEqual(r.data.memories.map((m) => m.kind), ["lesson", "decision", "outcome"]);
  });

  it("a shared project's memories are labelled with their source project", async () => {
    const h = await setup(server);
    await h.performAction("save-sharing", { shares: [{ projectId: "p2", readers: ["p1"] }] }, board);
    const r = await h.executeTool("memory_recall", { query: "anything" }, runCtx());
    const shared = r.data.memories.find((m) => m.content === "Shared project decision");
    assert.equal(shared.sharedFrom, "Ops");
    assert.match(r.content, /Shared project decision \(OPS-3, shared from project "Ops"\)/);
    assert.doesNotMatch(r.content, /Own project lesson \(/);
  });

  it("sharing is opt-in per reader project; 'all' admits every project", async () => {
    const h = await setup(server, {}, { projects: [project("p1", "Memory"), project("p2", "Ops"), project("p3", "Lab")] });
    await h.performAction("save-sharing", { shares: [{ projectId: "p2", readers: ["p3"] }] }, board);
    let r = await h.executeTool("memory_recall", { query: "anything" }, runCtx());
    assert.ok(!r.data.memories.some((m) => m.content === "Shared project decision"));
    await h.performAction("save-sharing", { shares: [{ projectId: "p2", readers: "all" }] }, board);
    r = await h.executeTool("memory_recall", { query: "anything" }, runCtx());
    assert.ok(r.data.memories.some((m) => m.content === "Shared project decision"));
  });

  it("only a board user can save sharing, and only for this company's projects", async () => {
    const h = await setup(server);
    await assert.rejects(h.performAction("save-sharing", { shares: [{ projectId: "p2", readers: "all" }] }, { actor: { type: "agent", agentId: "agent-1" }, companyId: A }), /board user/);
    await assert.rejects(h.performAction("save-sharing", { shares: [{ projectId: "p-foreign", readers: "all" }] }, board), /not in this company/);
    const data = await h.getData("sharing-settings", { companyId: A });
    assert.deepEqual(data.shares, []);
    assert.deepEqual(data.projects.map((p) => p.name).sort(), ["Memory", "Ops"]);
  });

  it("archiving a shared project does not lock the sharing page", async () => {
    const h = await setup(server, {}, { projects: [project("p1", "Memory"), project("p2", "Ops"), project("p3", "Lab")] });
    await h.performAction("save-sharing", { shares: [{ projectId: "p2", readers: ["p1"] }, { projectId: "p1", readers: ["p3"] }] }, board);
    h.seed({ projects: [{ ...project("p2", "Ops"), archivedAt: new Date() }] });
    // The page still holds p2's share and p2 as a reader, and sends them back.
    const saved = await h.performAction("save-sharing", { shares: [{ projectId: "p2", readers: ["p1"] }, { projectId: "p1", readers: ["p3", "p2"] }, { projectId: "p3", readers: ["p1"] }] }, board);
    const expected = [{ projectId: "p1", projectName: "Memory", readers: ["p3"] }, { projectId: "p3", projectName: "Lab", readers: ["p1"] }];
    assert.deepEqual(saved.shares, expected);
    assert.deepEqual((await h.getData("sharing-settings", { companyId: A })).shares, expected);
    await assert.rejects(h.performAction("save-sharing", { shares: [{ projectId: "p-foreign", readers: "all" }] }, board), /not in this company/);
  });

  it("a shared project the host no longer lists is dropped, not refused", async () => {
    const h = await setup(server, {}, { projects: [project("p1", "Memory"), project("p2", "Ops"), project("p3", "Lab")] });
    await h.performAction("save-sharing", { shares: [{ projectId: "p3", readers: ["p1"] }] }, board);
    h.seed({ projects: [project("p3", "Lab", B)] });
    const saved = await h.performAction("save-sharing", { shares: [{ projectId: "p3", readers: ["p1"] }, { projectId: "p2", readers: ["p1"] }] }, board);
    assert.deepEqual(saved.shares, [{ projectId: "p2", projectName: "Ops", readers: ["p1"] }]);
  });

  it("the settings page round-trips sharing", async () => {
    const h = await setup(server);
    await h.performAction("save-sharing", { shares: [{ projectId: "p2", readers: ["p1"] }, { projectId: "p1", readers: [] }] }, board);
    const data = await h.getData("sharing-settings", { companyId: A });
    assert.deepEqual(data.shares, [{ projectId: "p2", projectName: "Ops", readers: ["p1"] }]);
  });

  it("the recall-scopes route answers what a reader project may read, per company", async () => {
    const h = await setup(server);
    await h.performAction("save-sharing", { shares: [{ projectId: "p2", readers: ["p1"] }] }, board);
    assert.deepEqual((await api(h, "recall-scopes", { projectId: "p1" })).body.scopes, [{ projectId: "p2", projectName: "Ops" }]);
    assert.deepEqual((await api(h, "recall-scopes", { projectId: "p2" })).body.scopes, []);
    assert.deepEqual((await api(h, "recall-scopes", { projectId: "p1" }, B)).body.scopes, []);
  });

  it("memory_recall drops results whose metadata names another company", async () => {
    server.state.store.push({ userId: `paperclip-${A}`, cubeId: `paperclip-${A}-p1`, content: "Leaked", info: { companyId: B, projectId: "p1" } });
    const h = await setup(server);
    const r = await h.executeTool("memory_recall", { query: "anything" }, runCtx());
    assert.ok(!r.data.memories.some((m) => m.content === "Leaked"));
  });

  it("memory_retain stores once, reports duplicates, and accepts the fact type", async () => {
    const h = await setup(server);
    const first = await h.executeTool("memory_retain", { content: "Deploys go through DevOps", kind: "fact" }, runCtx());
    const second = await h.executeTool("memory_retain", { content: "deploys go through **DevOps**." }, runCtx());
    assert.equal(first.data.status, "stored");
    assert.equal(second.data.status, "duplicate");
    assert.equal(adds(server)[0].body.info.kind, "fact");
  });

  it("memory_retain refuses an issue from another project and writes nothing", async () => {
    const h = await setup(server, {}, { issues: [issue({ id: "iss-p2", projectId: "p2" })] });
    const r = await h.executeTool("memory_retain", { content: "Cross-project write", issueId: "iss-p2" }, runCtx());
    assert.equal(r.data.status, "rejected");
    assert.equal(adds(server).length, 0);
  });
});

describe("plugin fails open", () => {
  it("MemOS down: capture does not throw, recall is empty, retain reports failure", async () => {
    const url = await deadUrl();
    const fake = await startFakeServer();
    try {
      const h = await setup({ url }, { openrouterBaseUrl: fake.url });
      await h.emit("issue.comment.created", ...commentEvent());
      const recall = await h.executeTool("memory_recall", { query: "x" }, runCtx());
      assert.deepEqual(recall.data.memories, []);
      const retain = await h.executeTool("memory_retain", { content: "Something durable" }, runCtx());
      assert.equal(retain.data.status, "failed");
    } finally {
      await fake.close();
    }
  });

  it("a broken sharing state reads as own project only", async () => {
    const fake = await startFakeServer();
    try {
      const h = await setup(fake);
      await h.ctx.state.set({ scopeKind: "company", scopeId: A, namespace: "memos-settings", stateKey: "sharing" }, { shares: "nonsense" });
      assert.deepEqual((await api(h, "recall-scopes", { projectId: "p1" })).body.scopes, []);
    } finally {
      await fake.close();
    }
  });
});
