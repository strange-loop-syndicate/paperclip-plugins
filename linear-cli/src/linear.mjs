// Linear GraphQL client and the CLI's commands. No dependencies: global `fetch` only.
// Every command returns a plain object; the CLI prints it as JSON.

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const PAGE_SIZE = 100;
export const MAX_PAGES = 50;
const TIMEOUT_MS = 20_000;

/** A usage or input problem: exit code 2. */
export class UsageError extends Error {
  name = "UsageError";
}

/** Linear refused, failed or answered with something unexpected: exit code 1. */
export class LinearError extends Error {
  name = "LinearError";
}

/** A write succeeded but the readback does not show it: exit code 3. */
export class ReadbackError extends Error {
  name = "ReadbackError";
  constructor(message, readback) {
    super(message);
    this.readback = readback;
  }
}

const ISSUE_FIELDS = `
  id identifier title description url priority priorityLabel createdAt updatedAt
  state { id name type }
  team { id key name }
  assignee { id name displayName }
  delegate { id name displayName }
  project { id name }
  parent { id identifier }
  labels { nodes { id name } }
`;

const COMMENT_FIELDS = `
  id body url createdAt updatedAt editedAt resolvedAt
  parent { id }
  user { id name displayName }
  resolvingUser { id name displayName }
  issue { id identifier }
`;

export const QUERIES = {
  whoami: `query LinearCliWhoami {
  viewer { id name displayName email }
  organization { id name urlKey }
}`,
  issue: `query LinearCliIssue($id: String!) {
  issue(id: $id) { ${ISSUE_FIELDS} }
}`,
  issueRef: `query LinearCliIssueRef($id: String!) {
  issue(id: $id) { id identifier }
}`,
  issueTeamStates: `query LinearCliIssueStates($id: String!) {
  issue(id: $id) {
    id identifier
    state { id name type }
    team { id key states(first: 250) { nodes { id name type } } }
  }
}`,
  comments: `query LinearCliComments($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    id identifier
    comments(first: $first, after: $after) {
      nodes { ${COMMENT_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`,
  comment: `query LinearCliComment($id: String!) {
  comment(id: $id) { ${COMMENT_FIELDS} }
}`,
  setState: `mutation LinearCliSetState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id } }
}`,
  commentCreate: `mutation LinearCliCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`,
  commentResolve: `mutation LinearCliResolve($id: String!) {
  commentResolve(id: $id) { success comment { id } }
}`,
};

/** Personal keys (`lin_api_…`) go in the header as-is; anything else is an OAuth token. */
export function authorizationHeader(apiKey) {
  if (apiKey.startsWith("lin_api_")) return apiKey;
  if (/^bearer /i.test(apiKey)) return apiKey;
  return `Bearer ${apiKey}`;
}

function graphqlErrorText(errors) {
  if (!Array.isArray(errors)) return "unknown error";
  return errors
    .map((e) => {
      const err = e ?? {};
      const detail = err.extensions?.userPresentableMessage;
      const code = err.extensions?.code;
      return [err.message, detail && detail !== err.message ? detail : null, code ? `(${code})` : null]
        .filter((x) => typeof x === "string" && x)
        .join(" ");
    })
    .join("; ");
}

/**
 * Builds the client. `fetchImpl` is injectable for tests; the key never leaves
 * the Authorization header and is scrubbed from every error message.
 */
export function createClient({ apiKey, fetchImpl = globalThis.fetch }) {
  const scrub = (text) => (apiKey ? String(text).split(apiKey).join("[redacted]") : String(text));

  async function request(query, variables = {}) {
    let response;
    try {
      response = await fetchImpl(LINEAR_GRAPHQL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: authorizationHeader(apiKey) },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new LinearError(scrub(`Linear request failed: ${err instanceof Error ? err.message : err}`));
    }
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new LinearError(scrub(`Linear HTTP ${response.status}, non-JSON body: ${text.slice(0, 300)}`));
    }
    // Linear answers GraphQL errors with HTTP 400 and an `errors` array; report those, not just the status.
    if (payload?.errors) {
      throw new LinearError(scrub(`Linear GraphQL error (HTTP ${response.status}): ${graphqlErrorText(payload.errors)}`));
    }
    if (!response.ok) throw new LinearError(scrub(`Linear HTTP ${response.status}: ${text.slice(0, 300)}`));
    if (!payload || typeof payload.data !== "object" || payload.data === null) {
      throw new LinearError("Linear response has no data");
    }
    return payload.data;
  }

  return { request };
}

function flattenIssue(issue) {
  const { labels, ...rest } = issue;
  return { ...rest, labels: Array.isArray(labels?.nodes) ? labels.nodes : [] };
}

function flattenComment(comment) {
  const { parent, ...rest } = comment;
  return { ...rest, parentId: parent?.id ?? null };
}

function requireArg(value, what) {
  if (typeof value !== "string" || !value.trim() || /\s/.test(value.trim())) {
    throw new UsageError(`missing or invalid ${what}`);
  }
  return value.trim();
}

async function fetchIssue(client, key) {
  const data = await client.request(QUERIES.issue, { id: key });
  if (!data.issue) throw new LinearError(`issue ${key} not found`);
  return flattenIssue(data.issue);
}

async function fetchComment(client, id) {
  const data = await client.request(QUERIES.comment, { id });
  if (!data.comment) throw new LinearError(`comment ${id} not found`);
  return flattenComment(data.comment);
}

export async function whoami(client) {
  const data = await client.request(QUERIES.whoami);
  if (!data.viewer) throw new LinearError("Linear response has no viewer");
  return { viewer: data.viewer, organization: data.organization ?? null };
}

export async function getIssue(client, key) {
  return fetchIssue(client, requireArg(key, "issue key"));
}

/** All comments on the issue, every page, oldest first. Replies carry `parentId`. */
export async function listComments(client, key) {
  key = requireArg(key, "issue key");
  const comments = [];
  let after = null;
  let issue = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) throw new LinearError(`more than ${MAX_PAGES * PAGE_SIZE} comments on ${key}; stopped`);
    const data = await client.request(QUERIES.comments, { id: key, first: PAGE_SIZE, after });
    if (!data.issue) throw new LinearError(`issue ${key} not found`);
    issue ??= { id: data.issue.id, identifier: data.issue.identifier };
    const conn = data.issue.comments;
    if (!Array.isArray(conn?.nodes)) throw new LinearError("Linear response has no comments.nodes");
    comments.push(...conn.nodes.map(flattenComment));
    if (conn.pageInfo?.hasNextPage !== true) break;
    if (typeof conn.pageInfo.endCursor !== "string" || !conn.pageInfo.endCursor) {
      throw new LinearError("Linear says there is a next page but gives no endCursor");
    }
    after = conn.pageInfo.endCursor;
  }
  comments.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return { issue, count: comments.length, comments };
}

/** Moves the issue to the team's workflow state with this name (case-insensitive), then reads it back. */
export async function setState(client, key, stateName) {
  key = requireArg(key, "issue key");
  if (typeof stateName !== "string" || !stateName.trim()) throw new UsageError("missing state name");
  const wanted = stateName.trim().toLowerCase();

  const data = await client.request(QUERIES.issueTeamStates, { id: key });
  if (!data.issue) throw new LinearError(`issue ${key} not found`);
  const states = data.issue.team?.states?.nodes;
  if (!Array.isArray(states)) throw new LinearError("Linear response has no team.states");
  const matches = states.filter((s) => String(s.name).trim().toLowerCase() === wanted);
  if (matches.length === 0) {
    const names = states.map((s) => s.name).join(", ");
    throw new UsageError(`team ${data.issue.team.key} has no state "${stateName}". States: ${names}`);
  }
  if (matches.length > 1) throw new LinearError(`team ${data.issue.team.key} has ${matches.length} states named "${stateName}"`);
  const target = matches[0];

  const result = await client.request(QUERIES.setState, { id: data.issue.id, stateId: target.id });
  if (result.issueUpdate?.success !== true) throw new LinearError(`issueUpdate on ${key} did not succeed`);

  const readback = await fetchIssue(client, data.issue.id);
  if (readback.state?.id !== target.id) {
    throw new ReadbackError(`readback shows state "${readback.state?.name}", expected "${target.name}"`, readback);
  }
  return readback;
}

/** Posts a comment (or a threaded reply), then reads it back. */
export async function comment(client, key, { body, parentId } = {}) {
  key = requireArg(key, "issue key");
  if (typeof body !== "string" || !body.trim()) throw new UsageError("comment body is empty");
  if (parentId !== undefined) parentId = requireArg(parentId, "parent comment id");

  const issueData = await client.request(QUERIES.issueRef, { id: key });
  if (!issueData.issue) throw new LinearError(`issue ${key} not found`);
  const input = { issueId: issueData.issue.id, body };
  if (parentId) input.parentId = parentId;

  const result = await client.request(QUERIES.commentCreate, { input });
  const id = result.commentCreate?.comment?.id;
  if (result.commentCreate?.success !== true || typeof id !== "string") {
    throw new LinearError(`commentCreate on ${key} did not succeed`);
  }

  const readback = await fetchComment(client, id);
  if (readback.issue?.id !== issueData.issue.id) {
    throw new ReadbackError(`readback comment is on ${readback.issue?.identifier}, expected ${key}`, readback);
  }
  if ((readback.parentId ?? null) !== (parentId ?? null)) {
    throw new ReadbackError(`readback parentId is ${readback.parentId}, expected ${parentId ?? null}`, readback);
  }
  // Linear may normalise markdown, so a body difference is reported, not fatal. Callers check the tail.
  return { ...readback, bodyMatches: String(readback.body).trim() === body.trim() };
}

/** Resolves a comment thread, then reads it back. */
export async function resolveComment(client, id) {
  id = requireArg(id, "comment id");
  const result = await client.request(QUERIES.commentResolve, { id });
  if (result.commentResolve?.success !== true) throw new LinearError(`commentResolve on ${id} did not succeed`);
  const readback = await fetchComment(client, id);
  if (!readback.resolvedAt) throw new ReadbackError(`readback shows comment ${id} not resolved`, readback);
  return readback;
}
