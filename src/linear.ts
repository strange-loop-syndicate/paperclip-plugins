import type { AssignmentField } from "./config.ts";

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const PAGE_SIZE = 100;
const TIMEOUT_MS = 20_000;

export interface LinearIssue {
  identifier: string;
  title: string;
  url: string;
  project: { id: string; name: string } | null;
}

export interface LinearIssuePage {
  issues: LinearIssue[];
  hasNextPage: boolean;
}

export class LinearError extends Error {
  override name = "LinearError";
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Read-only query: Todo issues (state type "unstarted") in the given teams whose
 * assignee or delegate is the agent user. Selects only what the task title,
 * link and project mapping need.
 */
export function buildIntakeQuery(field: AssignmentField): string {
  return `query LinearIntake($teamKeys: [String!]!, $userId: ID!) {
  issues(
    first: ${PAGE_SIZE}
    filter: {
      team: { key: { in: $teamKeys } }
      ${field}: { id: { eq: $userId } }
      state: { type: { eq: "unstarted" } }
    }
  ) {
    nodes { identifier title url project { id name } }
    pageInfo { hasNextPage }
  }
}`;
}

function graphqlErrorText(errors: unknown): string {
  if (!Array.isArray(errors)) return "unknown error";
  return errors
    .map((e) => {
      const err = (e ?? {}) as { message?: unknown; extensions?: { userPresentableMessage?: unknown } };
      const detail = err.extensions?.userPresentableMessage;
      return [err.message, detail].filter((x) => typeof x === "string" && x).join(": ");
    })
    .join("; ");
}

export async function fetchIntakeIssues(
  fetchImpl: Fetch,
  apiKey: string,
  input: { teamKeys: string[]; userId: string; field: AssignmentField },
): Promise<LinearIssuePage> {
  let response: Response;
  try {
    response = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: apiKey },
      body: JSON.stringify({
        query: buildIntakeQuery(input.field),
        variables: { teamKeys: input.teamKeys, userId: input.userId },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new LinearError(`Linear request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new LinearError(`Linear HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  let payload: { data?: { issues?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown } } }; errors?: unknown };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new LinearError(`Linear returned non-JSON: ${text.slice(0, 300)}`);
  }
  if (payload.errors) throw new LinearError(`Linear GraphQL error: ${graphqlErrorText(payload.errors)}`);

  const nodes = payload.data?.issues?.nodes;
  if (!Array.isArray(nodes)) throw new LinearError("Linear response has no issues.nodes");
  const issues: LinearIssue[] = [];
  for (const node of nodes) {
    const n = (node ?? {}) as Record<string, unknown>;
    if (typeof n.identifier !== "string" || typeof n.title !== "string" || typeof n.url !== "string") continue;
    const p = n.project as { id?: unknown; name?: unknown } | null | undefined;
    issues.push({
      identifier: n.identifier,
      title: n.title,
      url: n.url,
      project: p && typeof p.id === "string" ? { id: p.id, name: typeof p.name === "string" ? p.name : "" } : null,
    });
  }
  return { issues, hasNextPage: payload.data?.issues?.pageInfo?.hasNextPage === true };
}
