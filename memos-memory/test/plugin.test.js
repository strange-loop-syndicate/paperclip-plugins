import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { contentHash } from "../src/content.js";
import manifest from "../src/manifest.js";
import { createMemoryPlugin, EVENT_BUDGET_MS, RETRY_JOB_KEY, SECRET_RETRY_MS, SECRET_TTL_MS } from "../src/plugin.js";
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
const MEMORY = "Pre-prompt recall runs in a command wrapper, not a plugin hook.";
const dedupKey = (content, projectId = "p1") => ({ scopeKind: "company", scopeId: A, namespace: "memos-dedup", stateKey: `${projectId}:${contentHash(content)}` });
const verdictLog = (h) => h.logs.filter((l) => l.message === "memory capture verdict").at(-1)?.meta;
const api = (h, routeKey, query, companyId = A) => h.plugin.definition.onApiRequest({ routeKey, method: "GET", path: `/${routeKey}`, params: {}, query, body: null, actor: { actorType: "agent", actorId: "agent-1" }, companyId, headers: {} });

function resetServer(server) {
  server.state.mode = "ok";
  server.state.addMode = "ok";
  server.state.searchMode = "ok";
  server.state.similarity = null;
  server.state.store.length = 0;
  server.state.requests.length = 0;
  server.state.llm.mode = "ok";
  server.state.llm.chatMode = "ok";
  server.state.llm.answers = { decision: 0.9, lesson: 0.1, outcome: 0.2, fact: 0.1, routine: 0.1 };
  server.state.llm.memories = [{ type: "decision", text: "Pre-prompt recall runs in a command wrapper, not a plugin hook." }];
  server.state.llm.chatReply = null;
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
    await assert.rejects(s.resolve(secretRef(OR_SECRET), { companyId: A, configPath: "otherRef" }), /not bound/);
    assert.equal(await s.resolve(secretRef(OR_SECRET), { companyId: A, configPath: "openrouterApiKeyRef" }), OR_KEY);
  });

  it("the OpenAI key field is a secret picker, and there is no MemOS key field", () => {
    const props = manifest.instanceConfigSchema.properties;
    assert.equal(props.openrouterApiKeyRef.format, "secret-ref");
    assert.equal(props.openrouterApiKeyRef.type, "object");
    assert.equal(props.memosApiKeyRef, undefined);
    assert.deepEqual(Object.keys(props).filter((k) => props[k].format === "secret-ref"), ["openrouterApiKeyRef"]);
  });

  it("resolves the binding with the company and config path, and Jev gets the key", async () => {
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    assert.deepEqual(h.secrets.calls.map((c) => [c.ref, c.options]), [[secretRef(OR_SECRET), { companyId: A, configPath: "openrouterApiKeyRef" }]]);
    assert.equal(jevCalls(server)[0].headers.authorization, `Bearer ${OR_KEY}`);
    assert.equal(extractCalls(server)[0].headers.authorization, `Bearer ${OR_KEY}`);
    assert.equal(adds(server).length, 1);
  });

  it("MemOS gets no key: a leftover memosApiKeyRef is never resolved or sent", async () => {
    const secrets = fakeHostSecrets({
      bindings: [
        { companyId: A, secretId: OR_SECRET, configPath: "openrouterApiKeyRef" },
        { companyId: A, secretId: MEMOS_SECRET, configPath: "memosApiKeyRef" },
      ],
      values: { [OR_SECRET]: OR_KEY, [MEMOS_SECRET]: "memos-token" },
    });
    const h = await setup(server, { memosApiKeyRef: secretRef(MEMOS_SECRET) }, {}, { secrets });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 1);
    assert.equal(adds(server)[0].headers.authorization, undefined);
    assert.deepEqual(h.secrets.calls.map((c) => c.options.configPath), ["openrouterApiKeyRef"]);
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

  it("every entry names the project a save would write to", async () => {
    const now = clock();
    const seed = {
      issues: [issue(), issue({ id: "iss-2", projectId: null, identifier: "SLS-2" })],
      issueComments: [
        comment(),
        comment({ id: "c-skip" }),
        comment({ id: "c-code", body: "```sh\nnpm test\n```" }),
        comment({ id: "c-bad" }),
        comment({ id: "c-none", issueId: "iss-2" }),
      ],
    };
    const h = await setup(server, { captureMode: "shadow" }, seed, { now });
    const emit = (commentId, issueId = "iss-1") => h.emit("issue.comment.created", ...commentEvent({ eventId: `evt-${commentId}`, entityId: issueId }, { commentId }));
    await emit("c-1");
    await emit("c-code");
    await emit("c-none", "iss-2");
    server.state.llm.chatReply = { content: "Sorry, I cannot help with that." };
    await emit("c-bad");
    server.state.llm.answers = { decision: 0.1, lesson: 0.1, outcome: 0.1, fact: 0.1, routine: 0.9 };
    await emit("c-skip");
    const entries = (await api(h, "shadow-log", { date: "2026-10-24" })).body.entries;
    assert.deepEqual(
      entries.map((e) => [e.commentId, e.verdict, e.projectId]),
      [
        ["c-1", "pass", "p1"],
        ["c-code", "no-text", "p1"],
        ["c-none", "pass", "unscoped"],
        ["c-bad", "error", "p1"],
        ["c-skip", "skip", "p1"],
      ],
    );
  });
});

describe("capture: verdict log in save mode", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => resetServer(server));

  it("logs every verdict with memory types, not memory text", async () => {
    const now = clock();
    const seed = { issueComments: [comment(), comment({ id: "c-skip" }), comment({ id: "c-fail" })] };
    const h = await setup(server, { captureMode: "save" }, seed, { now });
    const emit = (commentId) => h.emit("issue.comment.created", ...commentEvent({ eventId: `evt-${commentId}` }, { commentId }));
    await emit("c-1");
    server.state.addMode = "empty";
    server.state.llm.memories = [{ type: "lesson", text: "MemOS can answer an add with no created memory." }];
    await emit("c-fail");
    server.state.llm.answers = { decision: 0.1, lesson: 0.1, outcome: 0.1, fact: 0.1, routine: 0.9 };
    await emit("c-skip");
    assert.equal(adds(server).length, 2);
    const res = await api(h, "shadow-log", { date: "2026-10-24" });
    assert.deepEqual(
      res.body.entries.map((e) => [e.commentId, e.mode, e.verdict, e.stored ?? null]),
      [
        ["c-1", "save", "pass", ["stored"]],
        ["c-fail", "save", "pass", ["failed"]],
        ["c-skip", "save", "skip", null],
      ],
    );
    const [pass, fail] = res.body.entries;
    assert.deepEqual(pass.memoryTypes, ["decision"]);
    assert.deepEqual(fail.memoryTypes, ["lesson"]);
    assert.equal(pass.memories, undefined);
    assert.equal(pass.type, "decision");
    assert.equal(pass.jevCostUsd, 0.0001);
    assert.equal(pass.extractCostUsd, 0.0002);
    assert.match(fail.error, /no created memory IDs/);
    assert.doesNotMatch(JSON.stringify(res.body), /command wrapper|answer an add|Tests pass/, "the save-mode log holds no memory or comment text");
    assert.equal(verdictLog(h).verdict, "skip", "the server log still gets every verdict");
  });
});

// A long agent comment, shaped like the SLS-145 one that sat in `pending`:
// headings, links, quoted titles and many facts.
const LONG_BODY = [
  "The bug is **already reported upstream**, so I did not open a new issue.",
  "## Existing upstream reports",
  ...Array.from({ length: 12 }, (_, i) => `- [#${14300 + i}](https://example.test/issues/${14300 + i}): "Plugin hot reload silently stops event delivery" in step ${i}; the watcher keeps the old folder {path ${i}}.`),
  "## Our evidence",
  ...Array.from({ length: 10 }, (_, i) => `- **Gap ${i}:** the last event was handled at 20:${10 + i}:17Z and events came back after the disable and the enable.`),
  "## What is needed",
  "- Someone with a GitHub account posts the draft. The card below asks you to route this. END-OF-LONG-COMMENT",
].join("\n");

describe("capture: an unusable extractor reply", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => resetServer(server));

  const longSeed = { issueComments: [comment({ body: LONG_BODY })] };
  const shadowEntries = async (h) => (await api(h, "shadow-log", { date: "2026-10-24" })).body.entries;

  it("a long comment reaches the extractor whole, with room for the reply", async () => {
    assert.ok(LONG_BODY.length > 2500, "the fixture is long");
    const h = await setup(server, { captureMode: "shadow" }, longSeed, { now: clock() });
    await h.emit("issue.comment.created", ...commentEvent());
    const [call] = extractCalls(server);
    assert.match(call.body.messages[1].content, /END-OF-LONG-COMMENT/, "the comment is not cut");
    assert.ok(call.body.max_tokens >= 1000, `max_tokens ${call.body.max_tokens} leaves room for three memories`);
    assert.equal((await shadowEntries(h))[0].verdict, "pass");
  });

  it("a reply cut off at max_tokens keeps its complete memories", async () => {
    const full = [
      { type: "fact", text: "Upstream issue #14335 reports that restartWorker clears the new worker's event subscriptions." },
      { type: "outcome", text: 'Upstream issue #10613 is titled "Plugin hot reload silently stops event delivery".' },
    ];
    const content = `\`\`\`json\n{"memories":[${full.map((m) => JSON.stringify(m)).join(",")},{"type":"fact","text":"The 2026.1012.0 watcher kept wat`;
    server.state.llm.chatReply = { content, finish_reason: "length" };
    const h = await setup(server, { captureMode: "shadow" }, longSeed, { now: clock() });
    await h.emit("issue.comment.created", ...commentEvent());
    const [entry] = await shadowEntries(h);
    assert.equal(entry.verdict, "pass");
    assert.equal(entry.salvaged, true);
    assert.deepEqual(entry.memories.map((m) => m.content), full.map((m) => m.text));
    assert.equal(pendingOf(h).length, 0);
  });

  it("an unescaped quote in a memory still yields the memory", async () => {
    server.state.llm.chatReply = { content: '{"memories":[{"type":"fact","text":"Upstream #10613 is titled "Plugin hot reload silently stops event delivery"."}]}' };
    const h = await setup(server, { captureMode: "shadow" }, longSeed, { now: clock() });
    await h.emit("issue.comment.created", ...commentEvent());
    const [entry] = await shadowEntries(h);
    assert.equal(entry.verdict, "pass");
    assert.deepEqual(entry.memories, [{ type: "fact", content: 'Upstream #10613 is titled "Plugin hot reload silently stops event delivery".' }]);
  });

  it("a reply with no memories list is an error verdict after one try, not a 24 h retry", async () => {
    server.state.llm.chatReply = { content: "I cannot post to GitHub, but here is a summary: SECRET-REPLY-TEXT" };
    const h = await setup(server, { captureMode: "shadow" }, longSeed, { now: clock() });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(extractCalls(server).length, 1, "no HTTP retry for an answer");
    assert.equal(pendingOf(h).length, 0, "nothing waits in pending");
    const [entry] = await shadowEntries(h);
    assert.equal(entry.verdict, "error");
    assert.match(entry.error, /^extractor: extractor answered without a memories list \(finish_reason=stop, \d+ chars, no JSON object\)$/);
    assert.equal(entry.extractCostUsd, 0.0002);
    assert.doesNotMatch(JSON.stringify(entry), /SECRET-REPLY-TEXT|END-OF-LONG-COMMENT/, "neither reply nor comment text is logged");

    await h.emit("issue.comment.created", ...commentEvent({ eventId: "evt-again" }));
    assert.equal(jevCalls(server).length, 1, "the item is done; a redelivery makes no new call");
  });

  it("an item already waiting leaves the queue on its first bad reply", async () => {
    const now = clock();
    server.state.llm.chatMode = "error503";
    const h = await setup(server, { captureMode: "shadow" }, longSeed, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(pendingOf(h).length, 1);

    server.state.llm.chatMode = "ok";
    server.state.llm.chatReply = { content: '{"memories": "none"}' };
    now.advance(11 * 60 * 1000);
    await h.runJob(RETRY_JOB_KEY);
    assert.equal(pendingOf(h).length, 0);
    const entries = await shadowEntries(h);
    assert.deepEqual(entries.map((e) => e.verdict), ["error"]);
  });

  it("a provider error inside a 200 has no answer and still waits", async () => {
    server.state.llm.chatReply = { content: "", finish_reason: "error" };
    const h = await setup(server, { captureMode: "shadow" }, longSeed, { now: clock() });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(pendingOf(h).length, 1);
    assert.match(pendingOf(h)[0].lastError, /no model reply \(finish_reason=error\)/);
    assert.deepEqual(await shadowEntries(h), []);
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

  it("a normal add is stored, sets the dedup marker, and leaves nothing waiting", async () => {
    const h = await setup(server, {}, {}, { now: clock() });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(server.state.store.length, 1);
    assert.equal(pendingOf(h).length, 0);
    assert.ok(h.getState(dedupKey(MEMORY)), "dedup marker set");
    const verdict = verdictLog(h);
    assert.deepEqual(verdict.stored, ["stored"]);
    assert.equal(verdict.error, undefined);
  });

  it("MemOS answers 200 but stores nothing: failed, no dedup marker, and the retry job stores it", async () => {
    const now = clock();
    server.state.addMode = "empty";
    const h = await setup(server, {}, {}, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 1, "MemOS was asked");
    assert.equal(server.state.store.length, 0);
    assert.equal(h.getState(dedupKey(MEMORY)) ?? null, null, "no dedup marker for a memory MemOS did not store");
    const verdict = verdictLog(h);
    assert.deepEqual(verdict.stored, ["failed"]);
    assert.equal(verdict.error, "memos: MemOS answered with no created memory IDs");
    const queue = pendingOf(h);
    assert.equal(queue.length, 1, "the item waits for a retry");
    assert.equal(queue[0].lastError, "memos: MemOS answered with no created memory IDs");
    assert.doesNotMatch(JSON.stringify({ verdict: verdict.error, queue }), /command wrapper/, "the reason holds no memory or comment text");

    server.state.addMode = "ok";
    now.advance(11 * 60 * 1000);
    await h.runJob(RETRY_JOB_KEY);
    assert.equal(server.state.store.length, 1, "stored on retry");
    assert.equal(pendingOf(h).length, 0);
    assert.ok(h.getState(dedupKey(MEMORY)), "dedup marker set once MemOS stored it");
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

  it("memory_retain reports failure when MemOS stores nothing, and the next call tries again", async () => {
    const h = await setup(server);
    server.state.addMode = "empty";
    const first = await h.executeTool("memory_retain", { content: "Deploys go through DevOps" }, runCtx());
    assert.equal(first.data.status, "failed");
    assert.match(first.content, /not stored/);
    assert.equal(h.getState(dedupKey("Deploys go through DevOps")) ?? null, null);
    server.state.addMode = "ok";
    const second = await h.executeTool("memory_retain", { content: "Deploys go through DevOps" }, runCtx());
    assert.equal(second.data.status, "stored");
    assert.equal(adds(server).length, 2);
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

const LESSON = "Restarting the Paperclip server stops every agent run in progress.";
const shadowEntries = async (h) => (await api(h, "shadow-log", { date: "2026-10-24" })).body.entries;
const dryRun = (h, body, { companyId = A, actor = { actorType: "agent", actorId: "agent-1" } } = {}) =>
  h.plugin.definition.onApiRequest({ routeKey: "dry-run", method: "POST", path: "/dry-run", params: {}, query: { companyId }, body, actor, companyId, headers: {} });
const extractUserText = (b) => b.messages.find((m) => m.role === "user").content;

describe("capture: durable memories only (SLS-200)", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => resetServer(server));

  it("drops task logs and task status after the extractor, and logs why without memory text", async () => {
    server.state.llm.memories = [
      { type: "outcome", text: "The context layer patch was merged as commit b7df3b51 after review." },
      { type: "fact", text: "The upgrade task stays blocked until the server restart finishes." },
      { type: "lesson", text: LESSON },
    ];
    const now = clock();
    const h = await setup(server, {}, {}, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.deepEqual(adds(server).map((r) => r.body.memory_content), [LESSON]);
    const [entry] = await shadowEntries(h);
    assert.equal(entry.verdict, "pass");
    assert.deepEqual(entry.memoryTypes, ["lesson"]);
    assert.deepEqual(entry.dropped, [
      { type: "outcome", reason: "commit-hash" },
      { type: "fact", reason: "task-status" },
    ]);
    assert.doesNotMatch(JSON.stringify(entry), /b7df3b51|server restart/);
  });

  it("an item whose memories are all noise is a noise verdict: nothing stored, nothing waits", async () => {
    server.state.llm.memories = [{ type: "outcome", text: "Tests pass at 26/26 on the patch branch." }];
    const now = clock();
    const h = await setup(server, {}, {}, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 0);
    assert.deepEqual((await shadowEntries(h)).map((e) => e.verdict), ["noise"]);
    assert.deepEqual(pendingOf(h), []);
    await h.emit("issue.comment.created", ...commentEvent({ eventId: "evt-again" }));
    assert.equal(jevCalls(server).length, 1, "the item is marked done");
  });

  it("drops a memory that names a task of this company, not one that names UTF-8", async () => {
    server.state.llm.memories = [
      { type: "fact", text: "The upgrade plan is tracked on SLS-186 for the Paperclip host." },
      { type: "fact", text: "Comment bodies reach the plugin as UTF-8 Markdown source." },
    ];
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    assert.deepEqual(adds(server).map((r) => r.body.memory_content), ["Comment bodies reach the plugin as UTF-8 Markdown source."]);
  });

  it("drops a memory that still holds a provider redaction label", async () => {
    server.state.llm.memories = [{ type: "decision", text: "Plugin deletes need approval from [PERSON_NAME] on the review task." }];
    const now = clock();
    const h = await setup(server, {}, {}, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 0);
    assert.deepEqual((await shadowEntries(h))[0].dropped, [{ type: "decision", reason: "redacted" }]);
  });

  it("sends paths, URLs and protected words as placeholders and stores them as written", async () => {
    const body = "Lesson: never run npm install in /Users/claude/work/paperclip-plugins-repo while Oleg's server at http://127.0.0.1:3100/api runs.";
    server.state.llm.memories = (b) => {
      const text = extractUserText(b);
      const tokens = text.match(/\{\{P\d+\}\}/g) ?? [];
      return [{ type: "lesson", text: `Never run npm install in ${tokens[0]} while ${tokens[1]}'s server at ${tokens[2]} runs.` }];
    };
    const h = await setup(server, { protectTerms: ["Oleg"] }, { issueComments: [comment({ body })] });
    await h.emit("issue.comment.created", ...commentEvent());
    const sent = extractUserText(extractCalls(server)[0].body);
    assert.doesNotMatch(sent, /\/Users\/claude|Oleg|127\.0\.0\.1/);
    assert.deepEqual(adds(server).map((r) => r.body.memory_content), ["Never run npm install in /Users/claude/work/paperclip-plugins-repo while Oleg's server at http://127.0.0.1:3100/api runs."]);
  });

  it("tells the extractor to drop open gaps, to-dos and task assignments", async () => {
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    const system = extractCalls(server)[0].body.messages[0].content;
    assert.match(system, /Open gaps, bugs, missing features and to-dos/);
    assert.match(system, /Who works on which task, revision or step/);
  });

  it("gives the extractor the task title but not the task ID", async () => {
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    const sent = extractUserText(extractCalls(server)[0].body);
    assert.match(sent, /Task title: Build memory/);
    assert.doesNotMatch(sent, /SLS-1/);
  });

  it("skips a memory the scope already holds in other words, and logs it as a duplicate", async () => {
    seedMemory(server.state, { companyId: A, projectId: "p1", content: "Recall runs before the prompt, inside a wrapper command." });
    server.state.similarity = (query, content) => (content.startsWith("Recall runs before") ? 0.86 : 0.2);
    const now = clock();
    const h = await setup(server, {}, {}, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 0);
    const [entry] = await shadowEntries(h);
    assert.equal(entry.verdict, "duplicate");
    assert.deepEqual(entry.duplicates, [{ type: "decision", similarity: 0.86, by: "cosine" }]);
    const search = server.memosRequests().find((r) => r.path === "/product/search").body;
    assert.equal(search.mem_cube_id, `paperclip-${A}-p1`);
    assert.equal(search.query, MEMORY);
  });

  it("stores a memory below the duplicate threshold, and honours a configured one", async () => {
    seedMemory(server.state, { companyId: A, projectId: "p1", content: "Recall runs before the prompt, inside a wrapper command." });
    server.state.similarity = () => 0.84;
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 1);
    resetServer(server);
    seedMemory(server.state, { companyId: A, projectId: "p1", content: "Recall runs before the prompt, inside a wrapper command." });
    server.state.similarity = () => 0.84;
    const strict = await setup(server, { dupSimilarity: 0.8 });
    await strict.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 0);
  });

  it("only searches the item's own scope: a near match in another project is not a duplicate", async () => {
    seedMemory(server.state, { companyId: A, projectId: "p2", content: MEMORY });
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 1);
  });

  it("a failed duplicate search stores the memory (fails open)", async () => {
    server.state.searchMode = "error500";
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 1);
  });

  it("shadow mode runs the duplicate search too and logs the duplicate with its text", async () => {
    seedMemory(server.state, { companyId: A, projectId: "p1", content: MEMORY });
    const now = clock();
    const h = await setup(server, { captureMode: "shadow" }, {}, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    const [entry] = await shadowEntries(h);
    assert.equal(entry.verdict, "duplicate");
    assert.deepEqual(entry.duplicates, [{ type: "decision", content: MEMORY, similarity: 1, by: "cosine" }]);
    assert.deepEqual(entry.memories, []);
  });

  it("memory_retain skips a memory the scope already holds in other words", async () => {
    seedMemory(server.state, { companyId: A, projectId: "p1", content: "Recall runs before the prompt, inside a wrapper command." });
    server.state.similarity = () => 0.9;
    const h = await setup(server);
    const res = await h.executeTool("memory_retain", { content: MEMORY, kind: "lesson" }, runCtx());
    assert.equal(res.data.status, "duplicate");
    assert.equal(adds(server).length, 0);
  });
});

describe("dry-run route: the capture rules without saving", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => resetServer(server));

  it("answers what a save would store and stores, logs and marks nothing", async () => {
    server.state.llm.memories = [
      { type: "lesson", text: LESSON },
      { type: "outcome", text: "The fix was merged and deployed on the lab host." },
    ];
    const now = clock();
    const h = await setup(server, {}, {}, { now });
    const res = await dryRun(h, { comments: [{ issueId: "iss-1", commentId: "c-1" }] });
    assert.equal(res.status, 200);
    const [r] = res.body.results;
    assert.equal(r.verdict, "pass");
    assert.equal(r.issueIdentifier, "SLS-1");
    assert.deepEqual(r.memories, [{ type: "lesson", content: LESSON }]);
    assert.deepEqual(r.dropped, [{ type: "outcome", content: "The fix was merged and deployed on the lab host.", reason: "task-outcome" }]);
    assert.equal(adds(server).length, 0);
    assert.equal(server.memosRequests().length, 0, "no duplicate search unless asked");
    assert.deepEqual(await shadowEntries(h), []);
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 1, "the real event still processes the item");
  });

  it("runs the duplicate search when asked", async () => {
    seedMemory(server.state, { companyId: A, projectId: "p1", content: MEMORY });
    const h = await setup(server);
    const res = await dryRun(h, { comments: [{ issueId: "iss-1", commentId: "c-1" }], dupCheck: true });
    assert.equal(res.body.results[0].verdict, "duplicate");
  });

  it("re-judges stored memory text: keep, or delete with the reason", async () => {
    server.state.llm.memories = (b) => (/Restarting/.test(extractUserText(b)) ? [{ type: "lesson", text: LESSON }] : [{ type: "outcome", text: "PR #12 was merged." }]);
    const h = await setup(server);
    const res = await dryRun(h, { memories: [{ id: "m1", text: LESSON }, { id: "m2", text: "SLS-148 PR #12 merged as 6ac94fc." }] });
    assert.deepEqual(
      res.body.results.map((r) => [r.id, r.verdict, r.dropped.map((d) => d.reason)]),
      [
        ["m1", "keep", []],
        ["m2", "delete", ["pr-number"]],
      ],
    );
    assert.equal(jevCalls(server).length, 0, "stored text skips the Jev gate");
    assert.equal(adds(server).length, 0);
  });

  it("refuses a bad body, a large batch, and a company without capture", async () => {
    const h = await setup(server);
    assert.equal((await dryRun(h, {})).status, 400);
    assert.equal((await dryRun(h, { comments: [], memories: [] })).status, 400);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ id: `m${i}`, text: "x".repeat(20) }));
    assert.equal((await dryRun(h, { memories: eleven })).status, 400);
    assert.equal((await dryRun(h, { memories: [{ id: "m", text: LESSON }] }, { companyId: B })).status, 503);
  });

  it("an issue of another company is ignored, even when named directly", async () => {
    const h = await setup(server, {}, { issues: [issue(), issue({ id: "iss-b", companyId: B })] });
    const res = await dryRun(h, { comments: [{ issueId: "iss-b", commentId: "c-1" }] });
    assert.deepEqual(res.body.results, [{ issueId: "iss-b", commentId: "c-1", verdict: "ignored" }]);
    assert.equal(jevCalls(server).length, 0);
  });

  it("stops at the daily budget", async () => {
    const now = clock();
    const h = await setup(server, {}, {}, { now });
    h.ctx.state.set({ scopeKind: "company", scopeId: A, namespace: "memos-dryrun", stateKey: "2026-10-24" }, { items: 2999 });
    const two = [{ id: "a", text: LESSON }, { id: "b", text: LESSON }];
    assert.equal((await dryRun(h, { memories: two })).status, 429);
    assert.equal((await dryRun(h, { memories: [two[0]] })).status, 200);
    now.advance(24 * 60 * 60 * 1000);
    assert.equal((await dryRun(h, { memories: two })).status, 200, "a new UTC day has a new budget");
  });
});

describe("duplicate search: the event deadline holds", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => resetServer(server));

  it("with no time left before the deadline, the search is skipped and the memory is stored", async () => {
    const now = clock();
    server.state.llm.memories = (b) => {
      now.advance(EVENT_BUDGET_MS);
      return [{ type: "decision", text: MEMORY }];
    };
    const h = await setup(server, {}, {}, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(server.memosRequests().filter((r) => r.path === "/product/search").length, 0);
    assert.equal(adds(server).length, 1);
  });
});

describe("duplicate judge: candidates the cosine check cannot settle (SLS-200)", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => resetServer(server));

  const STORED = "Recall runs before the prompt, inside a wrapper command.";
  // The fake answers the judge's chat call with this, and the extractor's with memories.
  const judgeReplies = (verdict) => (b) => (b.messages[0].content.includes("free of repeats") ? { content: verdict } : null);
  const judgeCalls = () => extractCalls(server).filter((r) => r.body.messages[0].content.includes("free of repeats"));

  it("a hit between the judge floor and the threshold goes to the judge; a yes skips the memory", async () => {
    seedMemory(server.state, { companyId: A, projectId: "p1", content: STORED });
    server.state.similarity = () => 0.75;
    server.state.llm.chatReply = judgeReplies('{"duplicate":true,"of":1}');
    const now = clock();
    const h = await setup(server, { dupSimilarity: 0.8 }, {}, { now });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 0);
    const [entry] = await shadowEntries(h);
    assert.equal(entry.verdict, "duplicate");
    assert.deepEqual(entry.duplicates, [{ type: "decision", similarity: 0.75, by: "judge" }]);
    const sent = judgeCalls()[0].body.messages[1].content;
    assert.match(sent, /NEW:\nPre-prompt recall runs in a command wrapper/);
    assert.match(sent, /EXISTING:\n1\. Recall runs before the prompt/);
  });

  it("a no from the judge stores the memory", async () => {
    seedMemory(server.state, { companyId: A, projectId: "p1", content: STORED });
    server.state.similarity = () => 0.75;
    server.state.llm.chatReply = judgeReplies('{"duplicate":false,"of":null}');
    const h = await setup(server, { dupSimilarity: 0.8 });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(judgeCalls().length, 1);
    assert.equal(adds(server).length, 1);
  });

  it("no judge call below the floor, at or above the threshold, or with the floor at 0", async () => {
    seedMemory(server.state, { companyId: A, projectId: "p1", content: STORED });
    server.state.llm.chatReply = judgeReplies('{"duplicate":true,"of":1}');
    server.state.similarity = () => 0.69;
    await (await setup(server, { dupSimilarity: 0.8 })).emit("issue.comment.created", ...commentEvent());
    assert.equal(judgeCalls().length, 0);
    assert.equal(adds(server).length, 1);
    resetServer(server);
    seedMemory(server.state, { companyId: A, projectId: "p1", content: STORED });
    server.state.llm.chatReply = judgeReplies('{"duplicate":true,"of":1}');
    server.state.similarity = () => 0.75;
    await (await setup(server, { dupSimilarity: 0.8, dupJudgeFloor: 0 })).emit("issue.comment.created", ...commentEvent());
    assert.equal(judgeCalls().length, 0);
    assert.equal(adds(server).length, 1);
    resetServer(server);
    seedMemory(server.state, { companyId: A, projectId: "p1", content: STORED });
    server.state.llm.chatReply = judgeReplies('{"duplicate":false,"of":null}');
    server.state.similarity = () => 0.81;
    await (await setup(server, { dupSimilarity: 0.8 })).emit("issue.comment.created", ...commentEvent());
    assert.equal(judgeCalls().length, 0, "the cosine check settles it");
    assert.equal(adds(server).length, 0);
  });

  it("a judge that gives no verdict stores the memory (fails open)", async () => {
    seedMemory(server.state, { companyId: A, projectId: "p1", content: STORED });
    server.state.similarity = () => 0.75;
    server.state.llm.chatReply = judgeReplies("I cannot tell.");
    const h = await setup(server, { dupSimilarity: 0.8 });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 1);
    assert.ok(h.logs.some((l) => /duplicate judge failed/.test(l.message)));
  });

  it("the dry-run route judges given pairs and stores nothing", async () => {
    server.state.llm.chatReply = (b) => ({ content: b.messages[1].content.includes("same lesson") ? '{"duplicate":true,"of":2}' : '{"duplicate":false,"of":null}' });
    const h = await setup(server);
    const res = await dryRun(h, {
      duplicates: [
        { id: "a", text: "The same lesson, said again.", candidates: ["Another fact.", "The same lesson."] },
        { id: "b", text: "A new fact.", candidates: ["Another fact."] },
        { id: "c", text: "No candidates.", candidates: [] },
      ],
    });
    assert.deepEqual(
      res.body.results.map((r) => [r.id, r.verdict, r.of ?? null]),
      [
        ["a", "duplicate", 2],
        ["b", "new", null],
        ["c", "error", null],
      ],
    );
    assert.equal(server.memosRequests().length, 0);
    assert.equal((await dryRun(h, { duplicates: [{ id: "x", text: "t", candidates: ["c"] }], memories: [{ id: "y", text: "t" }] })).status, 400);
  });
});
