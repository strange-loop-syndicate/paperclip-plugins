import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.mjs";
import { LINEAR_GRAPHQL_URL, PAGE_SIZE, QUERIES, authorizationHeader } from "../src/linear.mjs";

const KEY = "lin_api_TESTKEY0123456789";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const TEAM = { id: "team-m", key: "M", name: "Main" };
const STATES = [
  { id: "st-todo", name: "Todo", type: "unstarted" },
  { id: "st-prog", name: "In Progress", type: "started" },
  { id: "st-review", name: "In Review", type: "started" },
  { id: "st-done", name: "Done", type: "completed" },
];

function issueNode(overrides = {}) {
  return {
    id: ISSUE_ID,
    identifier: "M-696",
    title: "Intake test",
    description: "desc",
    url: "https://linear.app/sls/issue/M-696",
    priority: 3,
    priorityLabel: "Medium",
    createdAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:00:00.000Z",
    state: STATES[0],
    team: TEAM,
    assignee: null,
    delegate: { id: "u-agent", name: "Agent", displayName: "agent" },
    project: null,
    parent: null,
    labels: { nodes: [{ id: "l1", name: "Bug" }] },
    ...overrides,
  };
}

function commentNode(id, overrides = {}) {
  return {
    id,
    body: `body ${id}`,
    url: `https://linear.app/c/${id}`,
    createdAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:00:00.000Z",
    editedAt: null,
    resolvedAt: null,
    parent: null,
    user: { id: "u1", name: "Oleg", displayName: "oleg" },
    resolvingUser: null,
    issue: { id: ISSUE_ID, identifier: "M-696" },
    ...overrides,
  };
}

/** Mock fetch: routes by GraphQL operation name, records every call. */
function mockLinear(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1];
    calls.push({ url, op, variables: body.variables, headers: init.headers, query: body.query });
    const handler = handlers[op];
    if (!handler) throw new Error(`unexpected operation ${op}`);
    const out = handler(body.variables, calls.filter((c) => c.op === op).length);
    const status = out.status ?? 200;
    const payload = out.status ? out.payload : { data: out };
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
  };
  return { fetchImpl, calls, ops: () => calls.map((c) => c.op) };
}

async function cli(argv, { fetchImpl, env = { LINEAR_API_KEY: KEY }, files = {} } = {}) {
  let out = "";
  let err = "";
  const code = await run({
    argv,
    env,
    fetchImpl: fetchImpl ?? (async () => assert.fail("fetch must not be called")),
    readFile: async (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return Buffer.from(files[path], "utf8");
    },
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  });
  return { code, out, err, json: /^[[{]/.test(out) ? JSON.parse(out) : undefined };
}

test("missing LINEAR_API_KEY exits 2 with a clear error and makes no request", async () => {
  for (const env of [{}, { LINEAR_API_KEY: "" }, { LINEAR_API_KEY: "   " }]) {
    const r = await cli(["whoami"], { env });
    assert.equal(r.code, 2);
    assert.match(r.err, /LINEAR_API_KEY is not set/);
    assert.equal(r.out, "");
  }
});

test("authorization header: personal key as-is, other tokens as Bearer", () => {
  assert.equal(authorizationHeader(KEY), KEY);
  assert.equal(authorizationHeader("lin_oauth_abc"), "Bearer lin_oauth_abc");
  assert.equal(authorizationHeader("Bearer xyz"), "Bearer xyz");
});

test("whoami posts to the Linear endpoint with the key and prints viewer and organization", async () => {
  const m = mockLinear({
    LinearCliWhoami: () => ({
      viewer: { id: "u-agent", name: "Agent", displayName: "agent", email: "a@x" },
      organization: { id: "o1", name: "SLS", urlKey: "sls" },
    }),
  });
  const r = await cli(["whoami"], { fetchImpl: m.fetchImpl });
  assert.equal(r.code, 0, r.err);
  assert.equal(m.calls[0].url, LINEAR_GRAPHQL_URL);
  assert.equal(m.calls[0].headers.authorization, KEY);
  assert.deepEqual(r.json, {
    viewer: { id: "u-agent", name: "Agent", displayName: "agent", email: "a@x" },
    organization: { id: "o1", name: "SLS", urlKey: "sls" },
  });
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
});

test("the key is scrubbed from error messages", async () => {
  const m = mockLinear({
    LinearCliWhoami: () => ({ status: 401, payload: `bad key ${KEY}` }),
  });
  const r = await cli(["whoami"], { fetchImpl: m.fetchImpl });
  assert.equal(r.code, 1);
  assert.ok(!r.err.includes(KEY), r.err);
  assert.match(r.err, /\[redacted\]/);
});

test("GraphQL errors on HTTP 400 are reported with Linear's message", async () => {
  const m = mockLinear({
    LinearCliIssue: () => ({
      status: 400,
      payload: { errors: [{ message: "Entity not found", extensions: { code: "INVALID_INPUT", userPresentableMessage: "Could not find issue" } }] },
    }),
  });
  const r = await cli(["get-issue", "M-9999"], { fetchImpl: m.fetchImpl });
  assert.equal(r.code, 1);
  assert.match(r.err, /Entity not found Could not find issue \(INVALID_INPUT\)/);
});

test("get-issue prints the issue with labels flattened", async () => {
  const m = mockLinear({ LinearCliIssue: () => ({ issue: issueNode() }) });
  const r = await cli(["get-issue", "M-696"], { fetchImpl: m.fetchImpl });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(m.calls[0].variables, { id: "M-696" });
  assert.equal(r.json.identifier, "M-696");
  assert.deepEqual(r.json.labels, [{ id: "l1", name: "Bug" }]);
  assert.equal(r.json.state.name, "Todo");
});

test("get-issue on an unknown key exits 1", async () => {
  const m = mockLinear({ LinearCliIssue: () => ({ issue: null }) });
  const r = await cli(["get-issue", "M-1"], { fetchImpl: m.fetchImpl });
  assert.equal(r.code, 1);
  assert.match(r.err, /issue M-1 not found/);
});

test("list-comments follows every page and returns parentId and resolvedAt, oldest first", async () => {
  const page1 = [
    commentNode("c2", { createdAt: "2026-10-24T10:02:00.000Z", parent: { id: "c1" } }),
    commentNode("c1", { createdAt: "2026-10-24T10:01:00.000Z", resolvedAt: "2026-10-24T11:00:00.000Z" }),
  ];
  const page2 = [commentNode("c3", { createdAt: "2026-10-24T10:03:00.000Z" })];
  const m = mockLinear({
    LinearCliComments: (vars, n) =>
      n === 1
        ? { issue: { id: ISSUE_ID, identifier: "M-696", comments: { nodes: page1, pageInfo: { hasNextPage: true, endCursor: "cur1" } } } }
        : { issue: { id: ISSUE_ID, identifier: "M-696", comments: { nodes: page2, pageInfo: { hasNextPage: false, endCursor: "cur2" } } } },
  });
  const r = await cli(["list-comments", "M-696"], { fetchImpl: m.fetchImpl });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(
    m.calls.map((c) => c.variables),
    [
      { id: "M-696", first: PAGE_SIZE, after: null },
      { id: "M-696", first: PAGE_SIZE, after: "cur1" },
    ],
  );
  assert.equal(r.json.count, 3);
  assert.deepEqual(r.json.issue, { id: ISSUE_ID, identifier: "M-696" });
  assert.deepEqual(
    r.json.comments.map((c) => [c.id, c.parentId, c.resolvedAt]),
    [
      ["c1", null, "2026-10-24T11:00:00.000Z"],
      ["c2", "c1", null],
      ["c3", null, null],
    ],
  );
  assert.ok(!("parent" in r.json.comments[0]));
});

test("list-comments fails when Linear claims a next page without a cursor", async () => {
  const m = mockLinear({
    LinearCliComments: () => ({
      issue: { id: ISSUE_ID, identifier: "M-696", comments: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } },
    }),
  });
  const r = await cli(["list-comments", "M-696"], { fetchImpl: m.fetchImpl });
  assert.equal(r.code, 1);
  assert.match(r.err, /no endCursor/);
});

test("set-state resolves the team state by name (case-insensitive, unquoted words) and prints the readback", async () => {
  let current = STATES[0];
  const m = mockLinear({
    LinearCliIssueStates: () => ({ issue: { id: ISSUE_ID, identifier: "M-696", state: current, team: { ...TEAM, states: { nodes: STATES } } } }),
    LinearCliSetState: (vars) => {
      current = STATES.find((s) => s.id === vars.stateId);
      return { issueUpdate: { success: true, issue: { id: ISSUE_ID } } };
    },
    LinearCliIssue: () => ({ issue: issueNode({ state: current }) }),
  });
  const r = await cli(["set-state", "M-696", "in", "review"], { fetchImpl: m.fetchImpl });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(m.ops(), ["LinearCliIssueStates", "LinearCliSetState", "LinearCliIssue"]);
  assert.deepEqual(m.calls[1].variables, { id: ISSUE_ID, stateId: "st-review" });
  assert.equal(r.json.state.name, "In Review");
});

test("set-state with an unknown state lists the team's states and writes nothing", async () => {
  const m = mockLinear({
    LinearCliIssueStates: () => ({ issue: { id: ISSUE_ID, identifier: "M-696", state: STATES[0], team: { ...TEAM, states: { nodes: STATES } } } }),
  });
  const r = await cli(["set-state", "M-696", "Shipped"], { fetchImpl: m.fetchImpl });
  assert.equal(r.code, 2);
  assert.match(r.err, /no state "Shipped"\. States: Todo, In Progress, In Review, Done/);
  assert.deepEqual(m.ops(), ["LinearCliIssueStates"]);
});

test("set-state exits 3 and prints the readback when the state did not change", async () => {
  const m = mockLinear({
    LinearCliIssueStates: () => ({ issue: { id: ISSUE_ID, identifier: "M-696", state: STATES[0], team: { ...TEAM, states: { nodes: STATES } } } }),
    LinearCliSetState: () => ({ issueUpdate: { success: true, issue: { id: ISSUE_ID } } }),
    LinearCliIssue: () => ({ issue: issueNode({ state: STATES[0] }) }),
  });
  const r = await cli(["set-state", "M-696", "Done"], { fetchImpl: m.fetchImpl });
  assert.equal(r.code, 3);
  assert.match(r.err, /readback shows state "Todo", expected "Done"/);
  assert.equal(r.json.state.name, "Todo");
});

test("comment posts a threaded reply from --body-file and prints the readback", async () => {
  const body = "Log entry\n\n```\n    +++ indented\n```\n";
  const m = mockLinear({
    LinearCliIssueRef: () => ({ issue: { id: ISSUE_ID, identifier: "M-696" } }),
    LinearCliCommentCreate: () => ({ commentCreate: { success: true, comment: { id: "c9" } } }),
    LinearCliComment: () => ({ comment: commentNode("c9", { body, parent: { id: "c1" } }) }),
  });
  const r = await cli(["comment", "M-696", "--body-file", "/tmp/b.md", "--parent", "c1"], {
    fetchImpl: m.fetchImpl,
    files: { "/tmp/b.md": body },
  });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(m.calls[1].variables, { input: { issueId: ISSUE_ID, body, parentId: "c1" } });
  assert.deepEqual(m.calls[2].variables, { id: "c9" });
  assert.equal(r.json.id, "c9");
  assert.equal(r.json.parentId, "c1");
  assert.equal(r.json.bodyMatches, true);
});

test("comment without --parent sends no parentId and reports a changed body", async () => {
  const m = mockLinear({
    LinearCliIssueRef: () => ({ issue: { id: ISSUE_ID, identifier: "M-696" } }),
    LinearCliCommentCreate: () => ({ commentCreate: { success: true, comment: { id: "c9" } } }),
    LinearCliComment: () => ({ comment: commentNode("c9", { body: "trunc" }) }),
  });
  const r = await cli(["comment", "M-696", "--body-file", "b.md"], { fetchImpl: m.fetchImpl, files: { "b.md": "full body" } });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(m.calls[1].variables.input, { issueId: ISSUE_ID, body: "full body" });
  assert.equal(r.json.parentId, null);
  assert.equal(r.json.bodyMatches, false);
});

test("comment exits 3 when the readback lost the parent", async () => {
  const m = mockLinear({
    LinearCliIssueRef: () => ({ issue: { id: ISSUE_ID, identifier: "M-696" } }),
    LinearCliCommentCreate: () => ({ commentCreate: { success: true, comment: { id: "c9" } } }),
    LinearCliComment: () => ({ comment: commentNode("c9", { body: "x" }) }),
  });
  const r = await cli(["comment", "M-696", "--body-file", "b.md", "--parent", "c1"], { fetchImpl: m.fetchImpl, files: { "b.md": "x" } });
  assert.equal(r.code, 3);
  assert.match(r.err, /parentId is null, expected c1/);
});

test("comment refuses secret files, empty bodies and a missing --body-file without calling Linear", async () => {
  for (const path of ["/w/.env", "/w/.env.local", "/w/id.pem", "/w/server.key"]) {
    const r = await cli(["comment", "M-696", "--body-file", path], { files: { [path]: "SECRET=1" } });
    assert.equal(r.code, 2, path);
    assert.match(r.err, /refusing to read/);
  }
  assert.equal((await cli(["comment", "M-696", "--body-file", "e.md"], { files: { "e.md": "  \n" } })).code, 2);
  const noFile = await cli(["comment", "M-696"]);
  assert.equal(noFile.code, 2);
  assert.match(noFile.err, /needs --body-file/);
  const missing = await cli(["comment", "M-696", "--body-file", "nope.md"]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /cannot read --body-file/);
});

test("resolve-comment resolves and prints the readback", async () => {
  const m = mockLinear({
    LinearCliResolve: () => ({ commentResolve: { success: true, comment: { id: "c1" } } }),
    LinearCliComment: () => ({ comment: commentNode("c1", { resolvedAt: "2026-10-24T12:00:00.000Z" }) }),
  });
  const r = await cli(["resolve-comment", "c1"], { fetchImpl: m.fetchImpl });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(m.ops(), ["LinearCliResolve", "LinearCliComment"]);
  assert.equal(r.json.resolvedAt, "2026-10-24T12:00:00.000Z");
});

test("resolve-comment exits 3 when the readback is not resolved", async () => {
  const m = mockLinear({
    LinearCliResolve: () => ({ commentResolve: { success: true, comment: { id: "c1" } } }),
    LinearCliComment: () => ({ comment: commentNode("c1") }),
  });
  const r = await cli(["resolve-comment", "c1"], { fetchImpl: m.fetchImpl });
  assert.equal(r.code, 3);
});

test("usage errors: unknown command, wrong argument count, unknown flag, no command", async () => {
  for (const argv of [["delete-comment", "c1"], ["create-issue"], ["get-issue"], ["get-issue", "M-1", "M-2"], ["whoami", "--force"], []]) {
    const r = await cli(argv);
    assert.equal(r.code, 2, argv.join(" "));
  }
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /resolve-comment/);
});

test("the only mutations are issueUpdate (state only), commentCreate and commentResolve", () => {
  const mutations = Object.values(QUERIES)
    .filter((q) => q.trimStart().startsWith("mutation"))
    .map((q) => /\{\s*(\w+)\s*\(/.exec(q)?.[1])
    .sort();
  assert.deepEqual(mutations, ["commentCreate", "commentResolve", "issueUpdate"]);
  assert.match(QUERIES.setState, /input: \{ stateId: \$stateId \}/);
  for (const q of Object.values(QUERIES)) assert.doesNotMatch(q, /delete|archive|issueCreate/i);
});

test("bin/linear.mjs runs as a process and exits 2 without a key", () => {
  const bin = fileURLToPath(new URL("../bin/linear.mjs", import.meta.url));
  const env = { ...process.env };
  delete env.LINEAR_API_KEY;
  const r = spawnSync(process.execPath, [bin, "whoami"], { env, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /LINEAR_API_KEY is not set/);
});
