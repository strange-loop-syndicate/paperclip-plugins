import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createMemoryPlugin } from "../src/plugin.js";
import { deadUrl, seedMemory, startFakeServer } from "./helpers/fake-servers.js";

const A = "company-a";
const B = "company-b";

const issue = (over = {}) => ({ id: "iss-1", companyId: A, projectId: "p1", identifier: "SLS-1", title: "Build memory", status: "in_progress", ...over });
const comment = (over = {}) => ({
  id: "c-1",
  companyId: A,
  issueId: "iss-1",
  authorType: "agent",
  authorAgentId: "agent-1",
  authorUserId: null,
  createdByRunId: "run-1",
  body: "**Decision:** use a command wrapper for pre-prompt recall\n- Lesson: plugin events are fire-and-forget",
  presentation: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function commentEvent(over = {}) {
  return [
    { commentId: "c-1", bodySnippet: "…", identifier: "SLS-1", agentId: "agent-1", runId: "run-1" },
    { companyId: A, actorType: "agent", actorId: "agent-1", entityId: "iss-1", entityType: "issue", eventId: "evt-1", ...over },
  ];
}

async function setup(server, config = {}, seed = {}) {
  const harness = createTestHarness({ manifest, config: { memosBaseUrl: server.url, recallTimeoutMs: 500, captureTimeoutMs: 500, ...config } });
  harness.seed({ issues: [issue()], issueComments: [comment()], ...seed });
  const plugin = createMemoryPlugin();
  await plugin.definition.setup(harness.ctx);
  return harness;
}

const adds = (server) => server.memosRequests().filter((r) => r.path === "/product/add");
const runCtx = (over = {}) => ({ agentId: "agent-1", runId: "run-9", companyId: A, projectId: "p1", ...over });

describe("plugin capture", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => {
    server.state.mode = "ok";
    server.state.store.length = 0;
    server.state.requests.length = 0;
  });

  it("stores labelled memories from an agent comment with full metadata", async () => {
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    const stored = adds(server).map((r) => r.body);
    assert.equal(stored.length, 2);
    assert.equal(stored[0].memory_content, "use a command wrapper for pre-prompt recall");
    assert.equal(stored[0].user_id, `paperclip-${A}`);
    assert.equal(stored[0].mem_cube_id, `paperclip-${A}-p1`);
    const info = stored[0].info;
    for (const key of ["companyId", "projectId", "agentId", "issueId", "issueIdentifier", "runId", "kind", "contentHash"]) {
      assert.ok(info[key], `metadata.${key} is set`);
    }
    assert.equal(info.kind, "decision");
    assert.equal(stored[1].info.kind, "lesson");
  });

  it("is idempotent across sequential event redelivery", async () => {
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    await h.emit("issue.comment.created", ...commentEvent({ eventId: "evt-redelivered" }));
    assert.equal(adds(server).length, 2);
  });

  it("is idempotent across concurrent event redelivery (in-flight lock)", async () => {
    const h = await setup(server);
    await Promise.all([h.emit("issue.comment.created", ...commentEvent()), h.emit("issue.comment.created", ...commentEvent({ eventId: "evt-2" }))]);
    assert.equal(adds(server).length, 2);
  });

  it("captureProjectIds limits comment, run and retain capture to the listed projects", async () => {
    const off = await setup(server, { captureProjectIds: ["p2"] });
    await off.emit("issue.comment.created", ...commentEvent());
    await off.emit("agent.run.finished", { runId: "run-1", agentId: "agent-1", issueId: "iss-1" }, { companyId: A, actorType: "agent" });
    const refused = await off.executeTool("memory_retain", { content: "p1 note while capture is off" }, runCtx());
    assert.equal(refused.data.status, "rejected");
    assert.equal(adds(server).length, 0);

    const on = await setup(server, { captureProjectIds: ["p1"] });
    await on.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 2);
  });

  it("takes the run's newest agent comment as the outcome summary, whatever order the host lists them in", async () => {
    const at = (s) => new Date(`2026-10-23T10:00:${s}Z`);
    const h = await setup(server, {}, {
      // Mixed host order; the newest comment on the run is a user's and must be skipped.
      issueComments: [
        comment({ id: "c-1", body: "Starting work on it.", createdAt: at("10") }),
        comment({ id: "c-4", authorType: "user", authorAgentId: null, authorUserId: "u-1", body: "User says hi.", createdAt: at("40") }),
        comment({ id: "c-3", body: "Done. All tests pass.", createdAt: at("30") }),
        comment({ id: "c-2", body: "Halfway there.", createdAt: at("20") }),
      ],
    });
    await h.emit("agent.run.finished", { runId: "run-1", agentId: "agent-1", issueId: "iss-1" }, { companyId: A, actorType: "agent" });
    assert.match(adds(server)[0].body.memory_content, /Summary: Done\. All tests pass\.$/);
  });

  it("calls MemOS with the worker's own fetch, not ctx.http.fetch (the host blocks private IPs)", async () => {
    const h = await setup(server);
    h.ctx.http.fetch = async () => {
      throw new Error("All resolved IPs for 127.0.0.1 are in private/reserved ranges");
    };
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 2);
  });

  it("dedups by normalized content per scope, not across scopes", async () => {
    const h = await setup(server, {}, {
      issues: [issue(), issue({ id: "iss-2", identifier: "SLS-2" }), issue({ id: "iss-3", projectId: "p2", identifier: "SLS-3" })],
      issueComments: [
        comment(),
        comment({ id: "c-2", issueId: "iss-2", body: "Decision:  USE a command wrapper for **pre-prompt** recall." }),
        comment({ id: "c-3", issueId: "iss-3", body: "Decision: use a command wrapper for pre-prompt recall" }),
      ],
    });
    await h.emit("issue.comment.created", ...commentEvent());
    await h.emit("issue.comment.created", { commentId: "c-2", agentId: "agent-1" }, { companyId: A, actorType: "agent", actorId: "agent-1", entityId: "iss-2" });
    await h.emit("issue.comment.created", { commentId: "c-3", agentId: "agent-1" }, { companyId: A, actorType: "agent", actorId: "agent-1", entityId: "iss-3" });
    const decisions = adds(server).filter((r) => r.body.info.kind === "decision");
    assert.deepEqual(decisions.map((r) => r.body.mem_cube_id), [`paperclip-${A}-p1`, `paperclip-${A}-p2`]);
  });

  it("ignores comments written by users", async () => {
    const h = await setup(server, {}, { issueComments: [comment({ authorType: "user", authorAgentId: null, authorUserId: "u-1" })] });
    await h.emit("issue.comment.created", { commentId: "c-1", agentId: null }, { companyId: A, actorType: "user", actorId: "u-1", entityId: "iss-1" });
    assert.equal(adds(server).length, 0);
  });

  it("stores one task outcome per finished run", async () => {
    const h = await setup(server, {}, {
      issueComments: [comment({ body: "Done. Wrapper and plugin implemented, 30 tests pass." })],
    });
    const payload = { runId: "run-1", agentId: "agent-1", issueId: "iss-1", status: "succeeded" };
    const base = { companyId: A, actorType: "agent", actorId: "agent-1", entityId: "run-1", entityType: "heartbeat_run" };
    await h.emit("agent.run.finished", payload, base);
    await h.emit("agent.run.finished", payload, { ...base, eventId: "again" });
    const outcomes = adds(server).filter((r) => r.body.info.kind === "outcome");
    assert.equal(outcomes.length, 1);
    assert.match(outcomes[0].body.memory_content, /^Run finished on SLS-1 "Build memory"\. .*Summary: Done\. Wrapper and plugin implemented/);
    assert.equal(outcomes[0].body.info.runId, "run-1");
  });

  it("dedups identical outcomes from different runs by content", async () => {
    const h = await setup(server, {}, { issueComments: [] });
    for (const runId of ["r1", "r2", "r3"]) {
      await h.emit("agent.run.finished", { runId, agentId: "agent-1", issueId: "iss-1" }, { companyId: A, actorType: "agent", eventId: `e-${runId}` });
    }
    const outcomes = adds(server).filter((r) => r.body.info.kind === "outcome");
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].body.info.runId, "r1");
  });

  it("a redelivered run event with a changed issue status stays one outcome", async () => {
    const h = await setup(server, {}, { issueComments: [] });
    const payload = { runId: "run-1", agentId: "agent-1", issueId: "iss-1" };
    await h.emit("agent.run.finished", payload, { companyId: A, actorType: "agent" });
    h.ctx.issues.get = async () => issue({ status: "done" });
    await h.emit("agent.run.finished", payload, { companyId: A, actorType: "agent", eventId: "again" });
    assert.equal(adds(server).length, 1);
  });

  it("stores at most 20 memories from one comment", async () => {
    const body = Array.from({ length: 25 }, (_, i) => `Lesson: distinct engineering lesson number ${i}`).join("\n");
    const h = await setup(server, {}, { issueComments: [comment({ body })] });
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 20);
  });

  it("one failing state write does not skip the comment's other memories", async () => {
    const h = await setup(server);
    const realSet = h.ctx.state.set.bind(h.ctx.state);
    let calls = 0;
    h.ctx.state.set = async (...args) => {
      if (calls++ === 0) throw new Error("state store unavailable");
      return realSet(...args);
    };
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 2);
    assert.ok(h.logs.some((l) => l.level === "warn" && /dedup marker not saved.*state store unavailable/.test(l.message)));
  });

  it("memory_retain reports stored when the memory was added but its dedup marker failed", async () => {
    const h = await setup(server);
    h.ctx.state.set = async () => {
      throw new Error("state store unavailable");
    };
    const res = await h.executeTool("memory_retain", { content: "Use pnpm in the web repo" }, runCtx());
    assert.equal(res.data.status, "stored");
    assert.equal(adds(server).length, 1);
    assert.ok(h.logs.some((l) => l.level === "warn" && /dedup marker not saved/.test(l.message)));
  });

  it("never uses an issue from another company, even if the host returns one", async () => {
    const h = await setup(server);
    h.ctx.issues.get = async () => issue({ companyId: B });
    await h.emit("issue.comment.created", ...commentEvent());
    await h.emit("agent.run.finished", { runId: "run-1", agentId: "agent-1", issueId: "iss-1" }, { companyId: A, actorType: "agent" });
    assert.equal(adds(server).length, 0);
  });
});

describe("plugin tools", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => {
    server.state.mode = "ok";
    server.state.store.length = 0;
    server.state.requests.length = 0;
    seedMemory(server.state, { companyId: A, projectId: "p1", content: "A/p1: deploys go through DevOps", info: { kind: "lesson" } });
    seedMemory(server.state, { companyId: A, projectId: "p2", content: "A/p2: staging uses port 8443", info: { kind: "lesson" } });
    seedMemory(server.state, { companyId: B, projectId: "p1", content: "B/p1: secret plans of company B", info: { kind: "decision" } });
  });

  it("memory_recall reads only the caller's company + project by default", async () => {
    const h = await setup(server);
    const res = await h.executeTool("memory_recall", { query: "deploys" }, runCtx());
    assert.deepEqual(res.data.memories.map((m) => m.content), ["A/p1: deploys go through DevOps"]);
  });

  it("memory_recall adds same-company scopes only when allowlisted", async () => {
    const h = await setup(server, { sharedScopes: [{ companyId: A, projectId: "p2" }, { companyId: B, projectId: "p1" }] });
    const res = await h.executeTool("memory_recall", { query: "anything" }, runCtx());
    assert.deepEqual(res.data.memories.map((m) => m.content).sort(), ["A/p1: deploys go through DevOps", "A/p2: staging uses port 8443"]);
    const cubes = server.memosRequests().map((r) => r.body.mem_cube_id);
    assert.ok(!cubes.some((c) => c.includes(B)), "no request ever names company B");
  });

  it("memory_recall drops results whose metadata names another company", async () => {
    server.state.store.push({ userId: `paperclip-${A}`, cubeId: `paperclip-${A}-p1`, content: "leaked", info: { companyId: B } });
    const h = await setup(server);
    const res = await h.executeTool("memory_recall", { query: "x" }, runCtx());
    assert.ok(!res.data.memories.some((m) => m.content === "leaked"));
  });

  it("memory_retain refuses an issue from another project and writes nothing", async () => {
    const h = await setup(server, {}, { issues: [issue(), issue({ id: "iss-2", projectId: "p2", identifier: "SLS-2" })] });
    const res = await h.executeTool("memory_retain", { content: "p2 builds need node 22", kind: "lesson", issueId: "iss-2" }, runCtx());
    assert.match(res.error, /another project/);
    assert.equal(adds(server).length, 0);
  });

  it("memory_recall drops results nested under metadata.info or a MemOS user from another company", async () => {
    const h = await setup(server);
    server.state.store.push({ userId: `paperclip-${A}`, cubeId: `paperclip-${A}-p1`, content: "nested leak", info: {}, rawMetadata: { info: { companyId: B } } });
    server.state.store.push({ userId: `paperclip-${A}`, cubeId: `paperclip-${A}-p1`, content: "user leak", info: {}, rawMetadata: { user_id: `paperclip-${B}` } });
    const res = await h.executeTool("memory_recall", { query: "x" }, runCtx());
    const contents = res.data.memories.map((m) => m.content);
    assert.ok(!contents.includes("nested leak"), contents.join(", "));
    assert.ok(!contents.includes("user leak"), contents.join(", "));
    assert.ok(contents.includes("A/p1: deploys go through DevOps"));
  });

  it("memory_retain stores once and reports duplicates", async () => {
    const h = await setup(server);
    const first = await h.executeTool("memory_retain", { content: "Use pnpm in the web repo", kind: "lesson", issueId: "iss-1" }, runCtx());
    const second = await h.executeTool("memory_retain", { content: "use PNPM in the web repo.", kind: "lesson" }, runCtx());
    assert.equal(first.data.status, "stored");
    assert.equal(second.data.status, "duplicate");
    const stored = adds(server);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].body.info.issueIdentifier, "SLS-1");
    assert.equal(stored[0].body.info.runId, "run-9");
  });
});

describe("plugin fails open", () => {
  let server;
  before(async () => (server = await startFakeServer()));
  after(() => server.close());
  beforeEach(() => {
    server.state.mode = "ok";
    server.state.store.length = 0;
    server.state.requests.length = 0;
  });

  it("server down: capture does not throw, recall is empty, retain reports failure", async () => {
    const h = await setup({ url: await deadUrl() });
    await h.emit("issue.comment.created", ...commentEvent());
    const recall = await h.executeTool("memory_recall", { query: "x" }, runCtx());
    assert.deepEqual(recall.data.memories, []);
    const retain = await h.executeTool("memory_retain", { content: "something durable" }, runCtx());
    assert.equal(retain.data.status, "failed");
    assert.ok(h.logs.some((l) => l.level === "warn" && /memos (add|search) failed/.test(l.message)));
  });

  it("slow server: recall returns empty within the timeout", async () => {
    server.state.mode = "slow";
    const h = await setup(server, { recallTimeoutMs: 300 });
    const t0 = Date.now();
    const recall = await h.executeTool("memory_recall", { query: "x" }, runCtx());
    assert.deepEqual(recall.data.memories, []);
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
  });

  it("a fetch that ignores the abort signal still cannot hold recall past the deadline", async () => {
    const neverAborts = (url, init) => new Promise((resolve) => setTimeout(() => resolve(globalThis.fetch(url, { ...init, signal: undefined })), 2500));
    const harness = createTestHarness({ manifest, config: { memosBaseUrl: server.url, recallTimeoutMs: 300 } });
    await createMemoryPlugin({ fetchImpl: neverAborts }).definition.setup(harness.ctx);
    const t0 = Date.now();
    const recall = await harness.executeTool("memory_recall", { query: "x" }, runCtx());
    assert.deepEqual(recall.data.memories, []);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
  });

  it("a concurrent duplicate reports the first write's failure, not 'duplicate'", async () => {
    server.state.mode = "error500";
    const h = await setup(server);
    const [a, b] = await Promise.all([
      h.executeTool("memory_retain", { content: "Use pnpm in the web repo" }, runCtx()),
      h.executeTool("memory_retain", { content: "use pnpm in the web repo" }, runCtx()),
    ]);
    assert.deepEqual([a.data.status, b.data.status], ["failed", "failed"]);
  });

  it("500: capture is not marked as stored, so a later delivery retries", async () => {
    server.state.mode = "error500";
    const h = await setup(server);
    await h.emit("issue.comment.created", ...commentEvent());
    server.state.mode = "ok";
    server.state.requests.length = 0;
    await h.emit("issue.comment.created", ...commentEvent());
    assert.equal(adds(server).length, 2);
  });
});
