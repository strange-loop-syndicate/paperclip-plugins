import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fetchUsersByName, type LinearUser } from "./linear.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Project = Awaited<ReturnType<PluginContext["projects"]["list"]>>[number];

/** A config value that names nothing, or more than one thing. */
export class ResolveError extends Error {
  override name = "ResolveError";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** Names compare case-insensitively after trimming spaces. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function listed(items: Array<{ id: string; name: string }>): string {
  return items.map((x) => `${x.name} (${x.id})`).join(", ");
}

/**
 * Linear user id for a name, display name, email or id. An id is used as is,
 * with no Linear call.
 */
export async function resolveLinearUser(fetchImpl: Fetch, apiKey: string, value: string): Promise<string> {
  if (isUuid(value)) return value.trim();
  const candidates = await fetchUsersByName(fetchImpl, apiKey, value.trim());
  const matches = candidates.filter((u: LinearUser) => [u.name, u.displayName, u.email].some((n) => sameName(n, value)));
  if (matches.length === 0) {
    throw new ResolveError(`linearAgentUser "${value}": no Linear user has this name, display name or email`);
  }
  if (matches.length > 1) {
    throw new ResolveError(
      `linearAgentUser "${value}" matches ${matches.length} Linear users: ${listed(matches)}; use the email or the id`,
    );
  }
  return matches[0]!.id;
}

export type ProjectMatch = { kind: "one"; id: string } | { kind: "none" } | { kind: "many"; projects: Project[] };

/** Exact id first, then non-archived projects with the same name. */
export function matchProject(projects: Project[], value: string): ProjectMatch {
  const byId = projects.find((p) => p.id === value.trim());
  if (byId) return { kind: "one", id: byId.id };
  const byName = projects.filter((p) => !p.archivedAt && sameName(p.name, value));
  if (byName.length === 1) return { kind: "one", id: byName[0]!.id };
  return byName.length === 0 ? { kind: "none" } : { kind: "many", projects: byName };
}

export function resolveProject(projects: Project[], value: string, field: string): string {
  const match = matchProject(projects, value);
  if (match.kind === "one") return match.id;
  if (match.kind === "none") throw new ResolveError(`${field} "${value}": no Paperclip project has this name or id`);
  throw new ResolveError(`${field} "${value}" matches ${match.projects.length} Paperclip projects: ${listed(match.projects)}; use the id`);
}

/** Paperclip agent id for an id or a name. An id is used as is, with no agent lookup. */
export async function resolveAgent(ctx: PluginContext, companyId: string, value: string, field: string): Promise<string> {
  if (isUuid(value)) return value.trim();
  const agents = (await ctx.agents.list({ companyId })).filter((a) => a.status !== "terminated" && sameName(a.name, value));
  if (agents.length === 0) throw new ResolveError(`${field} "${value}": no Paperclip agent has this name`);
  if (agents.length > 1) {
    throw new ResolveError(`${field} "${value}" matches ${agents.length} Paperclip agents: ${listed(agents)}; use the id`);
  }
  return agents[0]!.id;
}
