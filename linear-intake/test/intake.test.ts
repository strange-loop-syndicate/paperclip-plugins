import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../src/worker.ts";
import manifest from "../src/manifest.ts";
import { JOB_KEY, STATE_NAMESPACE } from "../src/intake.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROJECT_LEAD = "e18b31d8-e737-4e89-8471-697d59b65453";
const DIRECTOR = "cccccccc-0000-4000-8000-0000000000d1";
const AGENT_USER = "389b91a0-1540-453a-b3c8-331850dfae9e";
const FALLBACK_PROJECT = "aaaaaaaa-0000-4000-8000-000000000001";
const LAB_PROJECT = "aaaaaaaa-0000-4000-8000-000000000002";
const R2H_PROJECT = "aaaaaaaa-0000-4000-8000-000000000003";
const EXO_PROJECT = "aaaaaaaa-0000-4000-8000-000000000004";
const TORBA_PROJECT = "aaaaaaaa-0000-4000-8000-000000000005";
const SECRET = { type: "secret_ref", secretId: "bbbbbbbb-0000-4000-8000-000000000001" };

const CONFIG = {
  linearApiKey: SECRET,
  linearAgentUser: AGENT_USER,
  teamKeys: ["M", "KNO"],
  fallbackProject: FALLBACK_PROJECT,
  projectLeadAgentId: PROJECT_LEAD,
};

/** The lab's Paperclip projects, by the names they have after the SLS-97 renames. */
const PROJECTS: Array<[string, string]> = [
  [FALLBACK_PROJECT, "Ops"],
  [LAB_PROJECT, "Experiments"],
  [R2H_PROJECT, "Right2Hope"],
  [EXO_PROJECT, "exo"],
  [TORBA_PROJECT, "Torba"],
];

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

function linearUsers(users: Array<{ id: string; name: string; displayName?: string; email?: string }>) {
  const nodes = users.map((u) => ({ displayName: u.name.toLowerCase(), email: `${u.id}@example.com`, ...u }));
  return new Response(JSON.stringify({ data: { users: { nodes } } }), { status: 200 });
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

function project(id: string, name: string = id, archivedAt: Date | null = null) {
  return { id, companyId: COMPANY, name, status: "in_progress", archivedAt } as never;
}

function agent(id: string, name: string, status = "idle") {
  return { id, companyId: COMPANY, name, status } as never;
}

function requestBody(call: FetchCall) {
  return JSON.parse(String(call.init.body)) as { query: string; variables: Record<string, unknown> };
}

function existingIssue(id: string, title: string, status = "in_progress") {
  return { id, companyId: COMPANY, title, status, projectId: null, assigneeAgentId: null } as never;
}

/**
 * Make `issues.create` behave like the live host (plugin-host-services.js): an
 * omitted status lands as `backlog`, and `actor.actorAgentId` becomes
 * `createdByAgentId`. The SDK harness defaults to `todo` and drops the actor.
 */
function likeHostCreate(harness: TestHarness): void {
  const create = harness.ctx.issues.create.bind(harness.ctx.issues);
  harness.ctx.issues.create = async (input) => {
    const task = await create({ ...input, status: input.status ?? "backlog" });
    task.createdByAgentId = input.actor?.actorAgentId ?? null;
    task.createdByUserId = input.actor?.actorUserId ?? null;
    return task;
  };
}

function newHarness(config: Record<string, unknown>): TestHarness {
  const harness = createTestHarness({ manifest, config });
  likeHostCreate(harness);
  harness.seed({ agents: [agent(DIRECTOR, "Project Director")] });
  return harness;
}

async function boundHarness(config: Record<string, unknown> = CONFIG): Promise<TestHarness> {
  const harness = newHarness(config);
  harness.seed({ projects: PROJECTS.map(([id, name]) => project(id, name)) });
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
  assert.equal(task.status, "todo");
  assert.equal(task.createdByAgentId, DIRECTOR);
  assert.equal(task.createdByUserId, null);

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
  assert.match(body.query, /delegate:\s*\{\s*id:\s*\{\s*eq:\s*\$userId/);
  assert.match(body.query, /state:\s*\{\s*type:\s*\{\s*eq:\s*"unstarted"/);
  assert.match(body.query, /team:\s*\{\s*key:\s*\{\s*in:\s*\$teamKeys/);
});

test("assignee mode filters on the Linear assignee instead of the delegate", async (t) => {
  const harness = await boundHarness({ ...CONFIG, assignmentField: "assignee" });
  const calls = stubFetch(t, () => linearOk([]));

  await harness.runJob(JOB_KEY);

  const body = JSON.parse(String(calls[0]!.init.body)) as { query: string };
  assert.match(body.query, /assignee:\s*\{\s*id:\s*\{\s*eq:\s*\$userId/);
  assert.doesNotMatch(body.query, /delegate:/);
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

  const restarted = newHarness(CONFIG);
  restarted.seed({ issues: await listTasks(harness), projects: [project(FALLBACK_PROJECT, "Ops")] });
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

test("project auto-mapping: exact name, different case, no project, no match -> fallback", async (t) => {
  const harness = await boundHarness();
  stubFetch(t, () =>
    linearOk([
      linearIssue("M-1", "Exact", { id: "lin-torba", name: "Torba" }),
      linearIssue("M-2", "Case differs", { id: "lin-r2h", name: "right2hope" }),
      linearIssue("M-3", "Spaces and case", { id: "lin-exp", name: "  EXPERIMENTS " }),
      linearIssue("M-4", "No project"),
      linearIssue("KNO-5", "No match", { id: "lin-x", name: "Unknown" }),
      linearIssue("KNO-6", "No match again", { id: "lin-x", name: "Unknown" }),
    ]),
  );

  await harness.runJob(JOB_KEY);

  const byTitle = new Map((await listTasks(harness)).map((x) => [x.title, x.projectId]));
  assert.equal(byTitle.get("[M-1] Exact"), TORBA_PROJECT);
  assert.equal(byTitle.get("[M-2] Case differs"), R2H_PROJECT);
  assert.equal(byTitle.get("[M-3] Spaces and case"), LAB_PROJECT);
  assert.equal(byTitle.get("[M-4] No project"), FALLBACK_PROJECT);
  assert.equal(byTitle.get("[KNO-5] No match"), FALLBACK_PROJECT);
  assert.equal(byTitle.get("[KNO-6] No match again"), FALLBACK_PROJECT);
  const unmatchedLogs = harness.logs.filter((l) => l.level === "warn" && /Linear project names/.test(l.message));
  assert.equal(unmatchedLogs.length, 1, "one unmatched-name line per run");
  assert.deepEqual((unmatchedLogs[0]!.meta as { linearProjects: string[] }).linearProjects, ["Unknown"]);
});

test("projectMap override wins over the name match; both sides take a name or an id", async (t) => {
  const harness = await boundHarness({
    ...CONFIG,
    projectMap: [
      { linearProject: "Torba", paperclipProject: "exo" },
      { linearProject: "lin-r2h", paperclipProject: LAB_PROJECT },
      { linearProject: "Gone", paperclipProject: "No such project" },
    ],
  });
  stubFetch(t, () =>
    linearOk([
      linearIssue("M-1", "Override by Linear name to Paperclip name", { id: "lin-torba", name: "Torba" }),
      linearIssue("M-2", "Override by Linear id to Paperclip id", { id: "lin-r2h", name: "Right2Hope" }),
      linearIssue("M-3", "Override target missing", { id: "lin-gone", name: "Gone" }),
      linearIssue("M-4", "Not overridden", { id: "lin-exo", name: "exo" }),
    ]),
  );

  await harness.runJob(JOB_KEY);

  const byTitle = new Map((await listTasks(harness)).map((x) => [x.title, x.projectId]));
  assert.equal(byTitle.get("[M-1] Override by Linear name to Paperclip name"), EXO_PROJECT);
  assert.equal(byTitle.get("[M-2] Override by Linear id to Paperclip id"), LAB_PROJECT);
  assert.equal(byTitle.get("[M-3] Override target missing"), FALLBACK_PROJECT);
  assert.equal(byTitle.get("[M-4] Not overridden"), EXO_PROJECT);
  assert.ok(harness.logs.some((l) => l.level === "warn" && /projectMap target/.test(l.message)));
});

test("auto-mapping skips archived projects and sends a name shared by two projects to the fallback", async (t) => {
  const harness = await boundHarness();
  harness.seed({
    projects: [
      project("aaaaaaaa-0000-4000-8000-0000000000a1", "Old", new Date("2026-01-01")),
      project("aaaaaaaa-0000-4000-8000-0000000000b1", "Twin"),
      project("aaaaaaaa-0000-4000-8000-0000000000b2", "twin"),
    ],
  });
  stubFetch(t, () =>
    linearOk([
      linearIssue("M-1", "Archived", { id: "lin-old", name: "Old" }),
      linearIssue("M-2", "Two projects", { id: "lin-twin", name: "Twin" }),
    ]),
  );

  await harness.runJob(JOB_KEY);

  const byTitle = new Map((await listTasks(harness)).map((x) => [x.title, x.projectId]));
  assert.equal(byTitle.get("[M-1] Archived"), FALLBACK_PROJECT);
  assert.equal(byTitle.get("[M-2] Two projects"), FALLBACK_PROJECT);
  assert.ok(harness.logs.some((l) => l.level === "warn" && /More than one Paperclip project/.test(l.message)));
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

test("the task is created in todo, so the host wakeup accepts it", async (t) => {
  const harness = await boundHarness();
  const creates = t.mock.method(harness.ctx.issues, "create");
  stubFetch(t, () => linearOk([linearIssue("M-695", "Live intake")]));

  // The harness requestWakeup refuses backlog, done and cancelled, like the host.
  await harness.runJob(JOB_KEY);

  assert.equal(creates.mock.calls[0]!.arguments[0].status, "todo");
  assert.deepEqual(creates.mock.calls[0]!.arguments[0].actor, { actorAgentId: DIRECTOR });
  assert.ok(!harness.logs.some((l) => l.level === "error"));
});

test("creator agent: by name, by id; no match -> clear error, nothing created", async (t) => {
  const OTHER = "cccccccc-0000-4000-8000-0000000000d2";
  const byName = await boundHarness({ ...CONFIG, creatorAgent: "chief of staff" });
  byName.seed({ agents: [agent(OTHER, "Chief of Staff")] });
  stubFetch(t, () => linearOk([linearIssue("M-1", "Task")]));
  await byName.runJob(JOB_KEY);
  assert.equal((await listTasks(byName))[0]!.createdByAgentId, OTHER);

  const byId = await boundHarness({ ...CONFIG, creatorAgent: OTHER });
  await byId.runJob(JOB_KEY);
  assert.equal((await listTasks(byId))[0]!.createdByAgentId, OTHER);

  const missing = newHarness(CONFIG);
  missing.seed({ projects: PROJECTS.map(([id, name]) => project(id, name)) });
  await plugin.definition.setup(missing.ctx);
  await plugin.definition.onConfigChanged?.(CONFIG, { companyId: COMPANY });
  const agents = t.mock.method(missing.ctx.agents, "list", async () => []);
  await assert.rejects(missing.runJob(JOB_KEY), /creatorAgent "Project Director": no Paperclip agent/);
  assert.ok(agents.mock.callCount() > 0);
  assert.equal((await listTasks(missing)).length, 0);
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
  const harness = await boundHarness({ ...CONFIG, assignmentField: "owner", teamKeys: [] });
  const calls = stubFetch(t, () => linearOk([]));

  await assert.rejects(harness.runJob(JOB_KEY), /assignmentField.*teamKeys/s);
  assert.equal(calls.length, 0);
});

test("validateConfig: only linearApiKey is required", async () => {
  assert.equal((await plugin.definition.onValidateConfig?.(CONFIG))?.ok, true);
  assert.equal((await plugin.definition.onValidateConfig?.({ linearApiKey: SECRET }))?.ok, true);
  assert.deepEqual(manifest.instanceConfigSchema?.required, ["linearApiKey"]);
  const bad = await plugin.definition.onValidateConfig?.({});
  assert.equal(bad?.ok, false);
  assert.deepEqual(bad?.errors, ["linearApiKey: choose a Paperclip secret"]);
});

test("a config with only the key: Claude Code by name, delegate, Ops by name, default Project Lead", async (t) => {
  const harness = await boundHarness({ linearApiKey: SECRET });
  const wakeups = wakeupSpy(t, harness);
  const calls = stubFetch(
    t,
    () => linearUsers([{ id: AGENT_USER, name: "Claude Code" }]),
    () => linearOk([linearIssue("M-123", "Port the three MCP tools")]),
  );

  await harness.runJob(JOB_KEY);

  assert.equal(calls.length, 2);
  const lookup = requestBody(calls[0]!);
  assert.match(lookup.query, /^\s*query\b/);
  assert.doesNotMatch(lookup.query, /mutation/i);
  assert.deepEqual(lookup.variables, { name: "Claude Code" });
  const intake = requestBody(calls[1]!);
  assert.equal(intake.variables.userId, AGENT_USER);
  assert.match(intake.query, /delegate:\s*\{\s*id:\s*\{\s*eq:\s*\$userId/);
  assert.deepEqual(intake.variables.teamKeys, ["M", "KNO"]);

  const [task] = await listTasks(harness);
  assert.equal(task!.projectId, FALLBACK_PROJECT);
  assert.equal(task!.assigneeAgentId, PROJECT_LEAD);
  assert.equal(wakeups.mock.callCount(), 1);
});

test("Linear agent user: a name is resolved once per worker, then cached", async (t) => {
  const harness = await boundHarness({ ...CONFIG, linearAgentUser: "claude code" });
  const calls = stubFetch(
    t,
    () => linearUsers([{ id: AGENT_USER, name: "Claude Code" }]),
    () => linearOk([]),
  );

  await harness.runJob(JOB_KEY);
  await harness.runJob(JOB_KEY);

  assert.equal(calls.length, 3, "user lookup, then one intake query per tick");
  assert.equal(requestBody(calls[2]!).variables.userId, AGENT_USER);
});

test("Linear agent user: an email matches, and a fuzzy API hit with another name does not", async (t) => {
  const harness = await boundHarness({ ...CONFIG, linearAgentUser: "Agent@Example.com" });
  const calls = stubFetch(
    t,
    () =>
      linearUsers([
        { id: "user-other", name: "Agent Smith", email: "smith@example.com" },
        { id: AGENT_USER, name: "Claude Code", email: "agent@example.com" },
      ]),
    () => linearOk([]),
  );

  await harness.runJob(JOB_KEY);

  assert.equal(requestBody(calls[1]!).variables.userId, AGENT_USER);
});

test("Linear agent user: an id is used as is, with no lookup", async (t) => {
  const harness = await boundHarness({ ...CONFIG, linearAgentUser: ` ${AGENT_USER} ` });
  const calls = stubFetch(t, () => linearOk([]));

  await harness.runJob(JOB_KEY);

  assert.equal(calls.length, 1);
  assert.match(requestBody(calls[0]!).query, /LinearIntake\(/);
  assert.equal(requestBody(calls[0]!).variables.userId, AGENT_USER);
});

test("Linear agent user: no match -> clear error, no intake query, nothing created", async (t) => {
  const harness = await boundHarness({ ...CONFIG, linearAgentUser: "Claude Code" });
  const calls = stubFetch(t, () => linearUsers([]));

  await assert.rejects(harness.runJob(JOB_KEY), /linearAgentUser "Claude Code": no Linear user/);
  assert.equal(calls.length, 1);
  assert.equal((await listTasks(harness)).length, 0);
  assert.ok(harness.logs.some((l) => l.level === "error" && /agent user not resolved/.test(l.message)));
});

test("Linear agent user: two matches -> error lists both, nothing created, nothing cached", async (t) => {
  const harness = await boundHarness({ ...CONFIG, linearAgentUser: "Claude Code" });
  const calls = stubFetch(t, () =>
    linearUsers([
      { id: "user-a", name: "Claude Code" },
      { id: "user-b", name: "Claude", displayName: "claude code" },
    ]),
  );

  await assert.rejects(harness.runJob(JOB_KEY), /matches 2 Linear users: .*user-a.*user-b/);
  await assert.rejects(harness.runJob(JOB_KEY), /matches 2/);
  assert.equal(calls.length, 2, "a failed lookup is retried next tick");
  assert.equal((await listTasks(harness)).length, 0);
});

test("fallback project: by name; no match or two matches -> clear error, nothing created", async (t) => {
  const byName = await boundHarness({ ...CONFIG, fallbackProject: "ops" });
  stubFetch(t, () => linearOk([linearIssue("M-1", "No project")]));
  await byName.runJob(JOB_KEY);
  assert.equal((await listTasks(byName))[0]!.projectId, FALLBACK_PROJECT);

  const missing = await boundHarness({ ...CONFIG, fallbackProject: "Operations" });
  await assert.rejects(missing.runJob(JOB_KEY), /fallbackProject "Operations": no Paperclip project/);
  assert.equal((await listTasks(missing)).length, 0);
  assert.ok(missing.logs.some((l) => l.level === "error"));

  const twins = await boundHarness({ ...CONFIG, fallbackProject: "Ops" });
  twins.seed({ projects: [project("aaaaaaaa-0000-4000-8000-0000000000c1", "OPS")] });
  await assert.rejects(twins.runJob(JOB_KEY), /fallbackProject "Ops" matches 2 Paperclip projects/);
  assert.equal((await listTasks(twins)).length, 0);
});

test("fallback project is not resolved on an idle tick", async (t) => {
  const harness = await boundHarness({ ...CONFIG, fallbackProject: "No such project" });
  stubFetch(t, () => linearOk([]));

  await harness.runJob(JOB_KEY);

  assert.ok(!harness.logs.some((l) => l.level === "error"));
});

test("Project Lead by name; no match or two matches -> clear error, nothing created", async (t) => {
  const PL = "cccccccc-0000-4000-8000-000000000001";
  const harness = await boundHarness({ ...CONFIG, projectLeadAgentId: "project lead" });
  harness.seed({ agents: [agent(PL, "Project Lead"), agent("cccccccc-0000-4000-8000-000000000002", "Engineer")] });
  stubFetch(t, () => linearOk([linearIssue("M-1", "Task")]));
  await harness.runJob(JOB_KEY);
  assert.equal((await listTasks(harness))[0]!.assigneeAgentId, PL);

  const missing = await boundHarness({ ...CONFIG, projectLeadAgentId: "Project Lead" });
  await assert.rejects(missing.runJob(JOB_KEY), /projectLeadAgentId "Project Lead": no Paperclip agent/);
  assert.equal((await listTasks(missing)).length, 0);

  const twins = await boundHarness({ ...CONFIG, projectLeadAgentId: "Project Lead" });
  twins.seed({
    agents: [
      agent("cccccccc-0000-4000-8000-000000000003", "Project Lead"),
      agent("cccccccc-0000-4000-8000-000000000004", "project lead"),
      agent("cccccccc-0000-4000-8000-000000000005", "Project Lead", "terminated"),
    ],
  });
  await assert.rejects(twins.runJob(JOB_KEY), /matches 2 Paperclip agents/);
  assert.equal((await listTasks(twins)).length, 0);
});

test("a config saved with the old id fields keeps working", async (t) => {
  const harness = await boundHarness({
    linearApiKey: SECRET,
    linearAgentUserId: AGENT_USER,
    assignmentField: "assignee",
    fallbackProjectId: FALLBACK_PROJECT,
    projectMap: [{ linearProject: "lin-torba", paperclipProjectId: R2H_PROJECT }],
    projectLeadAgentId: PROJECT_LEAD,
  });
  const calls = stubFetch(t, () =>
    linearOk([
      linearIssue("M-1", "Old map row", { id: "lin-torba", name: "Torba" }),
      linearIssue("M-2", "No project"),
    ]),
  );

  await harness.runJob(JOB_KEY);

  assert.equal(calls.length, 1, "an id needs no user lookup");
  assert.equal(requestBody(calls[0]!).variables.userId, AGENT_USER);
  const byTitle = new Map((await listTasks(harness)).map((x) => [x.title, x.projectId]));
  assert.equal(byTitle.get("[M-1] Old map row"), R2H_PROJECT);
  assert.equal(byTitle.get("[M-2] No project"), FALLBACK_PROJECT);
});

test("new fields win over the old id fields", async (t) => {
  const harness = await boundHarness({
    ...CONFIG,
    linearAgentUserId: "dddddddd-0000-4000-8000-000000000001",
    fallbackProject: "Torba",
    fallbackProjectId: FALLBACK_PROJECT,
  });
  const calls = stubFetch(t, () => linearOk([linearIssue("M-1", "No project")]));

  await harness.runJob(JOB_KEY);

  assert.equal(requestBody(calls[0]!).variables.userId, AGENT_USER);
  assert.equal((await listTasks(harness))[0]!.projectId, TORBA_PROJECT);
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
