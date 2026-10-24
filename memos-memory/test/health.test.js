import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createMemoryPlugin } from "../src/plugin.js";
import { COMMENT_GRACE_MS, DEAF_AFTER_MS, HEALTH_JOB_KEY, MARK_EVERY_MS } from "../src/health.js";

const A = "company-a";
const B = "company-b";
const MIN = 60 * 1000;
const T0 = Date.parse("2026-10-25T10:00:00Z");

const INBOX = { id: "inbox-pd", companyId: A, projectId: "inboxes", identifier: "SLS-120", title: "Inbox: Project Director", status: "backlog" };
const WORK = { id: "iss-1", companyId: A, projectId: "p1", identifier: "SLS-1", title: "Build memory", status: "in_progress" };
const MARKS = { scopeKind: "instance", namespace: "memos-health", stateKey: "last-event" };
const ALERT = (companyId = A) => ({ scopeKind: "company", scopeId: companyId, namespace: "memos-health", stateKey: "alert" });

function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

// No MemOS and no OpenRouter key: capture stays off, so these tests see only
// the health check.
async function setup({ now, config = {}, issues = [INBOX, WORK] } = {}) {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ issues: issues.map((i) => ({ ...i, updatedAt: new Date(now()), lastActivityAt: new Date(now()) })) });
  const plugin = createMemoryPlugin({ now, sleep: async () => {} });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

let seq = 0;
/** A comment written at `at`, and the issue's activity moved to match, as the host does. */
async function addComment(h, now, { issue = WORK, at = now(), authorType = "agent", companyId = issue.companyId, presentation = null, metadata = null } = {}) {
  const id = `c-${++seq}`;
  h.seed({
    issues: [{ ...issue, updatedAt: new Date(at), lastActivityAt: new Date(at) }],
    issueComments: [{ id, companyId, issueId: issue.id, authorType, authorAgentId: authorType === "agent" ? "agent-1" : null, body: "status", presentation, metadata, createdAt: new Date(at), updatedAt: new Date(at) }],
  });
  return id;
}

const event = (h, companyId = A, commentId = `c-${seq}`) =>
  h.emit("issue.comment.created", { commentId }, { companyId, actorType: "agent", actorId: "agent-1", entityId: WORK.id, entityType: "issue" });

const alertsOn = async (h, issue = INBOX) => (await h.ctx.issues.listComments(issue.id, issue.companyId)).filter((c) => /stopped getting events/.test(c.body));
const errors = (h) => h.logs.filter((l) => l.level === "error");
const recoveries = (h) => h.logs.filter((l) => /events are back/.test(l.message));
const runJob = (h) => h.runJob(HEALTH_JOB_KEY);

describe("event health: alert when events stop", () => {
  it("is declared as an every-minute job, and the plugin may post the alert comment", () => {
    const job = manifest.jobs.find((j) => j.jobKey === HEALTH_JOB_KEY);
    assert.equal(job.schedule, "* * * * *");
    assert.ok(manifest.capabilities.includes("issue.comments.create"));
    assert.equal(manifest.instanceConfigSchema.properties.eventHealthIssue.default, "SLS-120");
  });

  it("healthy: comments with their events keep it quiet", async () => {
    const now = clock();
    const h = await setup({ now });
    for (let i = 0; i < 30; i++) {
      await addComment(h, now);
      await event(h);
      now.advance(MIN);
      await runJob(h);
    }
    assert.equal((await alertsOn(h)).length, 0);
    assert.equal(errors(h).length, 0);
  });

  it("quiet company: no comments and no events for hours is not an outage", async () => {
    const now = clock();
    const h = await setup({ now });
    await addComment(h, now);
    await event(h);
    for (let i = 0; i < 180; i++) {
      now.advance(MIN);
      await runJob(h);
    }
    assert.equal((await alertsOn(h)).length, 0);
    assert.equal(errors(h).length, 0);
    assert.equal(h.getState(ALERT()), undefined);
  });

  it("deaf: comments without events give one error and one comment on SLS-120, however long it lasts", async () => {
    const now = clock();
    const h = await setup({ now });
    await addComment(h, now);
    await event(h);
    // The worker goes deaf: comments keep coming, events do not.
    for (let i = 0; i < 60; i++) {
      now.advance(MIN);
      await addComment(h, now);
      await runJob(h);
    }
    const alerts = await alertsOn(h);
    assert.equal(alerts.length, 1);
    assert.equal(errors(h).length, 1);
    assert.match(alerts[0].body, new RegExp(`No event since:\\*\\* ${new Date(T0).toISOString()}`));
    assert.match(alerts[0].body, /SLS-1\b/);
    assert.match(alerts[0].body, /disable, then enable/i);
    const alert = h.getState(ALERT());
    assert.equal(alert.posted, true);
    assert.equal(alert.since, new Date(T0).toISOString());
    assert.equal(alert.alertIssue, "SLS-120");
  });

  it("healthy: an event whose mark write was skipped does not leave its comment looking unheard", async () => {
    const now = clock();
    const h = await setup({ now });
    await addComment(h, now);
    await event(h);
    now.advance(MARK_EVERY_MS - 1000);
    await addComment(h, now);
    await event(h); // delivered, but within a minute of the last mark write
    for (let i = 0; i < 15; i++) {
      now.advance(MIN);
      await runJob(h);
    }
    assert.equal((await alertsOn(h)).length, 0);
    assert.equal(errors(h).length, 0);
  });

  it("waits the full 10 minutes without events before it alerts", async () => {
    const now = clock();
    const h = await setup({ now });
    await event(h);
    now.advance(MIN);
    await addComment(h, now);
    now.advance(DEAF_AFTER_MS - 2 * MIN);
    await runJob(h);
    assert.equal((await alertsOn(h)).length, 0, "9 minutes without events is not yet deaf");
    now.advance(MIN);
    await runJob(h);
    assert.equal((await alertsOn(h)).length, 1);
  });

  it("gives a fresh comment's event time to arrive", async () => {
    const now = clock();
    const h = await setup({ now });
    await event(h);
    now.advance(DEAF_AFTER_MS + 30 * MIN);
    await addComment(h, now);
    now.advance(COMMENT_GRACE_MS - 1000);
    await runJob(h);
    assert.equal((await alertsOn(h)).length, 0, "the comment is too new to count");
    await event(h);
    now.advance(2 * MIN);
    await runJob(h);
    assert.equal((await alertsOn(h)).length, 0, "its event came: healthy");
  });

  it("system and deleted comments do not count", async () => {
    const now = clock();
    const h = await setup({ now });
    await event(h);
    now.advance(MIN);
    await addComment(h, now, { authorType: "system" });
    h.seed({ issueComments: [{ id: "c-del", companyId: A, issueId: WORK.id, authorType: "agent", body: "", deletedAt: new Date(now()), createdAt: new Date(now()), updatedAt: new Date(now()) }] });
    now.advance(DEAF_AFTER_MS + MIN);
    await runJob(h);
    assert.equal((await alertsOn(h)).length, 0);
  });

  it("comments the host writes without an event do not count", async () => {
    const now = clock();
    const h = await setup({ now });
    await event(h);
    now.advance(2 * MIN);
    // Workspace-ready note, continuation-exhausted note, onboarding greeting, chat run summary.
    await addComment(h, now, { presentation: { kind: "workspace_ready" }, metadata: { authorizationReason: "allow_scoped_agent_write" } });
    await addComment(h, now, { metadata: { authorizationReason: "internal_agent_write" } });
    await addComment(h, now, { metadata: { authorizationReason: "onboarding first-task greeting" } });
    await addComment(h, now, { metadata: { authorizationReason: "allow_chat_run_presentation" } });
    now.advance(DEAF_AFTER_MS + MIN);
    await runJob(h);
    assert.equal((await alertsOn(h)).length, 0);
    // A comment from the comment routes does send an event, so it counts.
    await addComment(h, now, { metadata: { authorizationReason: "allow_scoped_agent_write" } });
    now.advance(COMMENT_GRACE_MS);
    await runJob(h);
    assert.equal((await alertsOn(h)).length, 1);
  });

  it("a missing alert issue is logged once per outage", async () => {
    const now = clock();
    const h = await setup({ now, config: { eventHealthIssue: "SLS-999" } });
    await event(h);
    now.advance(2 * MIN);
    await addComment(h, now);
    for (let i = 0; i < 15; i++) {
      now.advance(MIN);
      await runJob(h);
    }
    assert.equal(errors(h).length, 1);
    assert.equal(h.logs.filter((l) => /alert issue not found/.test(l.message)).length, 1);
    assert.equal((await alertsOn(h)).length, 0);
  });

  it("recovery: the next event logs one recovery line and clears the alert; a later outage alerts again", async () => {
    const now = clock();
    const h = await setup({ now });
    await event(h);
    now.advance(MIN);
    await addComment(h, now);
    now.advance(DEAF_AFTER_MS);
    await runJob(h);
    assert.equal((await alertsOn(h)).length, 1);

    // The board disables and enables the plugin: a new worker gets events again.
    const fresh = createMemoryPlugin({ now, sleep: async () => {} });
    await fresh.definition.setup(h.ctx);
    now.advance(MIN);
    await event(h);
    await runJob(h);
    await runJob(h);
    assert.equal(recoveries(h).length, 1);
    assert.equal(h.getState(ALERT()), undefined);
    assert.equal((await alertsOn(h)).length, 1, "recovery posts no comment");

    // A second outage is a new alert.
    now.advance(MIN);
    await addComment(h, now);
    now.advance(DEAF_AFTER_MS);
    await runJob(h);
    assert.equal((await alertsOn(h)).length, 2);
  });

  it("the forced test: setting the mark back produces exactly one alert", async () => {
    const now = clock();
    const h = await setup({ now });
    await addComment(h, now);
    await event(h);
    now.advance(MIN);
    await h.ctx.state.set(MARKS, { [A]: new Date(T0 - 60 * MIN).toISOString() });
    for (let i = 0; i < 5; i++) {
      await runJob(h);
      now.advance(MIN);
    }
    assert.equal((await alertsOn(h)).length, 1);
  });

  it("a failed post is retried on the next run, and still posts only once", async () => {
    const now = clock();
    const h = await setup({ now });
    await event(h);
    now.advance(MIN);
    await addComment(h, now);
    now.advance(DEAF_AFTER_MS);
    const real = h.ctx.issues.createComment;
    h.ctx.issues.createComment = async () => {
      throw new Error("host down");
    };
    await runJob(h);
    assert.equal((await alertsOn(h)).length, 0);
    h.ctx.issues.createComment = real;
    for (let i = 0; i < 3; i++) {
      now.advance(MIN);
      await runJob(h);
    }
    assert.equal((await alertsOn(h)).length, 1);
    assert.equal(errors(h).length, 1, "one error per outage");
  });

  it("a state store that cannot save the alert posts nothing", async () => {
    const now = clock();
    const h = await setup({ now });
    await event(h);
    now.advance(MIN);
    await addComment(h, now);
    now.advance(DEAF_AFTER_MS);
    const realSet = h.ctx.state.set;
    h.ctx.state.set = async (key, value) => {
      if (key.stateKey === "alert") throw new Error("state down");
      return realSet(key, value);
    };
    for (let i = 0; i < 3; i++) {
      await runJob(h);
      now.advance(MIN);
    }
    assert.equal((await alertsOn(h)).length, 0);
  });

  it("an empty alert issue logs the error once and posts nothing", async () => {
    const now = clock();
    const h = await setup({ now, config: { eventHealthIssue: "" } });
    await event(h);
    now.advance(MIN);
    await addComment(h, now);
    for (let i = 0; i < 15; i++) {
      now.advance(MIN);
      await runJob(h);
    }
    assert.equal(errors(h).length, 1);
    assert.equal((await alertsOn(h)).length, 0);
  });

  it("each company is checked on its own marks and comments", async () => {
    const now = clock();
    const B_WORK = { id: "iss-b", companyId: B, projectId: "pb", identifier: "BBB-1", title: "B work", status: "todo" };
    const B_INBOX = { id: "inbox-b", companyId: B, projectId: "ib", identifier: "SLS-120", title: "B inbox", status: "backlog" };
    const h = await setup({ now, issues: [INBOX, WORK, B_WORK, B_INBOX] });
    await event(h, A);
    await event(h, B);
    // B is busy and its events arrive; A is quiet.
    for (let i = 0; i < 20; i++) {
      now.advance(MIN);
      await addComment(h, now, { issue: B_WORK });
      await event(h, B);
      await runJob(h);
    }
    assert.equal((await alertsOn(h, INBOX)).length, 0);
    assert.equal((await alertsOn(h, B_INBOX)).length, 0);
  });

  it("a busy worker writes its mark at most once a minute", async () => {
    const now = clock();
    const h = await setup({ now });
    let writes = 0;
    const realSet = h.ctx.state.set;
    h.ctx.state.set = async (key, value) => {
      if (key.namespace === "memos-health" && key.stateKey === "last-event") writes++;
      return realSet(key, value);
    };
    for (let i = 0; i < 40; i++) {
      await event(h);
      now.advance(1000);
    }
    assert.equal(writes, 1);
    now.advance(MARK_EVERY_MS);
    await event(h);
    assert.equal(writes, 2);
    assert.equal(h.getState(MARKS)[A], new Date(now()).toISOString());
  });
});
