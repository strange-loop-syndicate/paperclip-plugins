import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../src/worker.ts";
import manifest from "../src/manifest.ts";
import { JOB_KEY, STATE_NAMESPACE } from "../src/intake.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROJECT_LEAD = "e18b31d8-e737-4e89-8471-697d59b65453";
const AGENT_USER = "linear-agent-user-1";
const FALLBACK_PROJECT = "aaaaaaaa-0000-4000-8000-000000000001";
const LAB_PROJECT = "aaaaaaaa-0000-4000-8000-000000000002";
const R2H_PROJECT = "aaaaaaaa-0000-4000-8000-000000000003";
const LINEAR_LAB_PROJECT_ID = "lin-proj-lab";

const CONFIG = {
  linearApiKey: { type: "secret_ref", secretId: "bbbbbbbb-0000-4000-8000-000000000001" },
  linearAgentUserId: AGENT_USER,
  teamKeys: ["M", "KNO"],
  projectMap: [
    { linearProject: LINEAR_LAB_PROJECT_ID, paperclipProjectId: LAB_PROJECT },
    { linearProject: "Right2Hope", paperclipProjectId: R2H_PROJECT },
  ],
  fallbackProjectId: FALLBACK_PROJECT,
  projectLeadAgentId: PROJECT_LEAD,
};

interface LinearNode {
  identifier: string;
  title: string;
  url: string;
  description?: string;
  project: { id: string; name: string } | null;
}

function linearIssue(key: string, title: string, project: LinearNode["project"] = null): LinearNode {
  return {
    identifier: key,
    title,
    url: `https://linear.app/sls/issue/${key.toLowerCase()}/slug`,
    description: "SECRET BODY that must not be copied",
    project,
  };
}

function linearOk(nodes: LinearNode[], hasNextPage = false) {
  return new Response(JSON.stringify({ data: { issues: { nodes, pageInfo: { hasNextPage } } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function stubFetch(t: TestContext, ...responses: Array<() => Response | Promise<Response>>) {
  const calls: FetchCall[] = [];
  let i = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(i++, responses.length - 1)];
    return next();
  });
  return calls;
}

function project(id: string) {
  return { id, companyId: COMPANY, name: id, status: "in_progress" } as never;
}

function existingIssue(id: string, title: string, status = "in_progress") {
  return { id, companyId: COMPANY, title, status, projectId: null, assigneeAgentId: null } as never;
}

async function boundHarness(config: Record<string, unknown> = CONFIG): Promise<TestHarness> {
  const harness = createTestHarness({ manifest, config });
  harness.seed({ projects: [project(FALLBACK_PROJECT), project(LAB_PROJECT), project(R2H_PROJECT)] });
  await plugin.definition.setup(harness.ctx);
  await plugin.definition.onConfigChanged?.(config, { companyId: COMPANY });
  return harness;
}

async function listTasks(harness: TestHarness) {
  return harness.ctx.issues.list({ companyId: COMPANY });
}

function stateFor(harness: TestHarness, key: string) {
  return harness.getState({ scopeKind: "company", scopeId: COMPANY, namespace: STATE_NAMESPACE, stateKey: key });
}

function wakeupSpy(t: TestContext, harness: TestHarness) {
  return t.mock.method(harness.ctx.issues, "requestWakeup");
}

test("new issue -> one Project Lead task with the URL only, one wakeup, key recorded", async (t) => {
  const harness = await boundHarness();
  const wakeups = wakeupSpy(t, harness);
  const calls = stubFetch(t, () => linearOk([linearIssue("M-123", "Port the three MCP tools")]));

  await harness.runJob(JOB_KEY);

  const tasks = await listTasks(harness);
  assert.equal(tasks.length, 1);
  const task = tasks[0]!;
  assert.equal(task.title, "[M-123] Port the three MCP tools");
  assert.equal(task.description, "https://linear.app/sls/issue/m-123/slug");
  assert.equal(task.assigneeAgentId, PROJECT_LEAD);
  assert.equal(task.projectId, FALLBACK_PROJECT);
  assert.equal(task.originId, "M-123");

  assert.equal(wakeups.mock.callCount(), 1);
  assert.equal(wakeups.mock.calls[0]!.arguments[0], task.id);
  assert.equal(wakeups.mock.calls[0]!.arguments[1], COMPANY);

  assert.deepEqual((stateFor(harness, "M-123") as { issueId: string }).issueId, task.id);
  assert.equal(calls.length, 1);
});

test("the Linear request is one read-only query scoped to teams, agent user and Todo", async (t) => {
  const harness = await boundHarness();
  const calls = stubFetch(t, () => linearOk([]));

  await harness.runJob(JOB_KEY);

  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url, "https://api.linear.app/graphql");
  assert.equal(init.method, "POST");
  const headers = new Headers(init.headers);
  assert.ok(headers.get("authorization"), "API key header is set");
  const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
  assert.match(body.query, /^\s*query\b/);
  assert.doesNotMatch(body.query, /mutation/i);
  assert.doesNotMatch(body.query, /description|comments|state\s*\{\s*name/);
  assert.deepEqual(body.variables, { teamKeys: ["M", "KNO"], userId: AGENT_USER });
  assert.match(body.query, /assignee:\s*\{\s*id:\s*\{\s*eq:\s*\$userId/);
  assert.match(body.query, /state:\s*\{\s*type:\s*\{\s*eq:\s*"unstarted"/);
  assert.match(body.query, /team:\s*\{\s*key:\s*\{\s*in:\s*\$teamKeys/);
});

test("delegate mode filters on the Linear delegate instead of the assignee", async (t) => {
  const harness = await boundHarness({ ...CONFIG, assignmentField: "delegate" });
  const calls = stubFetch(t, () => linearOk([]));

  await harness.runJob(JOB_KEY);

  const body = JSON.parse(String(calls[0]!.init.body)) as { query: string };
  assert.match(body.query, /delegate:\s*\{\s*id:\s*\{\s*eq:\s*\$userId/);
  assert.doesNotMatch(body.query, /assignee:/);
});

test("key already in plugin state -> no task, no wakeup", async (t) => {
  const harness = await boundHarness();
  await harness.ctx.state.set(
    { scopeKind: "company", scopeId: COMPANY, namespace: STATE_NAMESPACE, stateKey: "M-123" },
    { issueId: "old-task", createdAt: "2026-10-24T00:00:00.000Z" },
  );
  const wakeups = wakeupSpy(t, harness);
  stubFetch(t, () => linearOk([linearIssue("M-123", "Port the three MCP tools")]));

  await harness.runJob(JOB_KEY);

  assert.equal((await listTasks(harness)).length, 0);
  assert.equal(wakeups.mock.callCount(), 0);
});

test("existing [KEY] task (any status) -> no new task, no wakeup, key recorded", async (t) => {
  const harness = await boundHarness();
  harness.seed({ issues: [existingIssue("manual-1", "[M-123] Port the MCP tools (made by hand)", "done")] });
  const wakeups = wakeupSpy(t, harness);
  stubFetch(t, () => linearOk([linearIssue("M-123", "Port the three MCP tools")]));

  await harness.runJob(JOB_KEY);

  const tasks = await listTasks(harness);
  assert.deepEqual(tasks.map((x) => x.id), ["manual-1"]);
  assert.equal(wakeups.mock.callCount(), 0);
  assert.equal((stateFor(harness, "M-123") as { issueId: string }).issueId, "manual-1");
});

test("existing [KEY] task past the first 500 tasks is found when the host windows the list twice", async (t) => {
  const harness = await boundHarness();
  const filler = Array.from({ length: 600 }, (_, i) => existingIssue(`filler-${i}`, `[KNO-${9000 + i}] Filler`));
  harness.seed({ issues: [...filler, existingIssue("manual-late", "[M-123] Old low-priority task", "backlog")] });
  // The host applies limit/offset in SQL, then slices the result by offset again.
  const sqlWindowed = harness.ctx.issues.list.bind(harness.ctx.issues);
  t.mock.method(harness.ctx.issues, "list", async (params: Parameters<typeof sqlWindowed>[0]) => {
    const rows = await sqlWindowed(params);
    const offset = params.offset ?? 0;
    return params.limit == null ? rows.slice(offset) : rows.slice(offset, offset + params.limit);
  });
  const wakeups = wakeupSpy(t, harness);
  stubFetch(t, () => linearOk([linearIssue("M-123", "Port the three MCP tools")]));

  await harness.runJob(JOB_KEY);

  assert.equal((await sqlWindowed({ companyId: COMPANY })).length, 601);
  assert.equal(wakeups.mock.callCount(), 0);
  assert.equal((stateFor(harness, "M-123") as { issueId: string }).issueId, "manual-late");
});

test("a [KEY] prefix match needs the whole key: [M-1234] does not block M-123", async (t) => {
  const harness = await boundHarness();
  harness.seed({ issues: [existingIssue("other", "[M-1234] Something else")] });
  stubFetch(t, () => linearOk([linearIssue("M-123", "Port the three MCP tools")]));

  await harness.runJob(JOB_KEY);

  assert.equal((await listTasks(harness)).length, 2);
});

test("restart: a second tick after a lost state write creates no duplicate", async (t) => {
  const harness = await boundHarness();
  stubFetch(t, () => linearOk([linearIssue("M-123", "Port the three MCP tools")]));
  await harness.runJob(JOB_KEY);
  await harness.ctx.state.delete({ scopeKind: "company", scopeId: COMPANY, namespace: STATE_NAMESPACE, stateKey: "M-123" });

  const restarted = createTestHarness({ manifest, config: CONFIG });
  restarted.seed({ issues: await listTasks(harness), projects: [project(FALLBACK_PROJECT)] });
  await plugin.definition.setup(restarted.ctx);
  await plugin.definition.onConfigChanged?.(CONFIG, { companyId: COMPANY });
  await restarted.runJob(JOB_KEY);

  assert.equal((await restarted.ctx.issues.list({ companyId: COMPANY })).length, 1);
});

test("Linear HTTP error -> logged, job fails, nothing created, next tick retries", async (t) => {
  const harness = await boundHarness();
  stubFetch(
    t,
    () => new Response("upstream down", { status: 502 }),
    () => linearOk([linearIssue("M-123", "Port the three MCP tools")]),
  );

  await assert.rejects(harness.runJob(JOB_KEY), /Linear/);
  assert.equal((await listTasks(harness)).length, 0);
  assert.equal(stateFor(harness, "M-123") ?? null, null);
  assert.ok(harness.logs.some((l) => l.level === "error" && /502/.test(l.message + JSON.stringify(l.meta ?? {}))));

  await harness.runJob(JOB_KEY);
  assert.equal((await listTasks(harness)).length, 1);
});

test("Linear GraphQL error -> the extensions message is logged, nothing created", async (t) => {
  const harness = await boundHarness();
  stubFetch(
    t,
    () =>
      new Response(
        JSON.stringify({
          errors: [{ message: "Argument Validation Error", extensions: { userPresentableMessage: "bad filter" } }],
        }),
        { status: 200 },
      ),
  );

  await assert.rejects(harness.runJob(JOB_KEY), /bad filter/);
  assert.equal((await listTasks(harness)).length, 0);
});

test("Linear network failure -> logged, job fails, nothing created", async (t) => {
  const harness = await boundHarness();
  stubFetch(t, () => {
    throw new TypeError("fetch failed");
  });

  await assert.rejects(harness.runJob(JOB_KEY), /fetch failed/);
  assert.equal((await listTasks(harness)).length, 0);
  assert.ok(harness.logs.some((l) => l.level === "error"));
});

test("project map: by Linear project id, by name, and fallback for none / unmapped / missing", async (t) => {
  const harness = await boundHarness({
    ...CONFIG,
    projectMap: [
      ...CONFIG.projectMap,
      { linearProject: "Gone", paperclipProjectId: "aaaaaaaa-0000-4000-8000-00000000dead" },
    ],
  });
  stubFetch(t, () =>
    linearOk([
      linearIssue("M-1", "By id", { id: LINEAR_LAB_PROJECT_ID, name: "Experiment Lab" }),
      linearIssue("M-2", "By name", { id: "lin-proj-r2h", name: "Right2Hope" }),
      linearIssue("M-3", "No project"),
      linearIssue("KNO-4", "Unmapped", { id: "lin-proj-x", name: "Unknown" }),
      linearIssue("KNO-5", "Mapped to a missing project", { id: "lin-proj-gone", name: "Gone" }),
    ]),
  );

  await harness.runJob(JOB_KEY);

  const byTitle = new Map((await listTasks(harness)).map((x) => [x.title, x.projectId]));
  assert.equal(byTitle.get("[M-1] By id"), LAB_PROJECT);
  assert.equal(byTitle.get("[M-2] By name"), R2H_PROJECT);
  assert.equal(byTitle.get("[M-3] No project"), FALLBACK_PROJECT);
  assert.equal(byTitle.get("[KNO-4] Unmapped"), FALLBACK_PROJECT);
  assert.equal(byTitle.get("[KNO-5] Mapped to a missing project"), FALLBACK_PROJECT);
});

test("a failed wakeup still records the key, and the job reports the failure", async (t) => {
  const harness = await boundHarness();
  t.mock.method(harness.ctx.issues, "requestWakeup", async () => {
    throw new Error("budget exceeded");
  });
  stubFetch(t, () => linearOk([linearIssue("M-123", "Port the three MCP tools")]));

  await assert.rejects(harness.runJob(JOB_KEY), /M-123/);
  assert.equal((await listTasks(harness)).length, 1);
  assert.ok(stateFor(harness, "M-123"));
});

test("no bound company -> no Linear call", async (t) => {
  const harness = createTestHarness({ manifest, config: CONFIG });
  await plugin.definition.setup(harness.ctx);
  await plugin.definition.onConfigChanged?.(CONFIG, { companyId: null });
  const calls = stubFetch(t, () => linearOk([]));

  await harness.runJob(JOB_KEY);

  assert.equal(calls.length, 0);
  assert.ok(harness.logs.some((l) => l.level === "warn"));
});

test("invalid config -> no Linear call, job fails with the field names", async (t) => {
  const harness = await boundHarness({ ...CONFIG, linearAgentUserId: "", fallbackProjectId: undefined });
  const calls = stubFetch(t, () => linearOk([]));

  await assert.rejects(harness.runJob(JOB_KEY), /linearAgentUserId.*fallbackProjectId|fallbackProjectId.*linearAgentUserId/s);
  assert.equal(calls.length, 0);
});

test("validateConfig reports missing fields and accepts a full config", async () => {
  assert.equal((await plugin.definition.onValidateConfig?.(CONFIG))?.ok, true);
  const bad = await plugin.definition.onValidateConfig?.({});
  assert.equal(bad?.ok, false);
  assert.ok((bad?.errors ?? []).some((e) => /linearApiKey/.test(e)));
});

test("team keys default to M and KNO", async (t) => {
  const { teamKeys: _omit, ...rest } = CONFIG;
  const harness = await boundHarness(rest);
  const calls = stubFetch(t, () => linearOk([]));

  await harness.runJob(JOB_KEY);

  const body = JSON.parse(String(calls[0]!.init.body)) as { variables: { teamKeys: string[] } };
  assert.deepEqual(body.variables.teamKeys, ["M", "KNO"]);
});

test("more than one page of Linear results logs a warning", async (t) => {
  const harness = await boundHarness();
  stubFetch(t, () => linearOk([], true));

  await harness.runJob(JOB_KEY);

  assert.ok(harness.logs.some((l) => l.level === "warn" && /page/i.test(l.message)));
});
