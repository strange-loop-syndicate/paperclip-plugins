import type { PluginContext, ScopeKey } from "@paperclipai/plugin-sdk";
import type { IntakeConfig } from "./config.ts";
import { fetchIntakeIssues, type LinearIssue } from "./linear.ts";
import { matchProject, resolveAgent, resolveLinearUser, resolveProject, sameName } from "./resolve.ts";

export const JOB_KEY = "linear-intake";
export const STATE_NAMESPACE = "linear-intake";

export interface IntakeRecord {
  issueId: string;
  recordedAt: string;
  source: "created" | "existing";
}

export interface IntakeSummary {
  fetched: number;
  created: string[];
  adopted: string[];
  failed: string[];
}

function stateKey(companyId: string, key: string): ScopeKey {
  return { scopeKind: "company", scopeId: companyId, namespace: STATE_NAMESPACE, stateKey: key };
}

export function taskTitle(issue: LinearIssue): string {
  return `[${issue.identifier}] ${issue.title}`;
}

/**
 * Map key -> id of the first Paperclip task whose title starts with `[KEY]`, any status.
 * One unwindowed list call: the host applies `offset` twice (in SQL, then again on the
 * returned rows), so offset paging returns an empty second page. With no `limit` the
 * host returns every visible task.
 */
async function findTasksByKey(ctx: PluginContext, companyId: string, keys: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const prefixes = keys.map((key) => ({ key, prefix: `[${key}]` }));
  for (const task of await ctx.issues.list({ companyId })) {
    for (const { key, prefix } of prefixes) {
      if (!found.has(key) && task.title.startsWith(prefix)) found.set(key, task.id);
    }
  }
  return found;
}

type Project = Awaited<ReturnType<PluginContext["projects"]["list"]>>[number];

/** Linear user ids already resolved in this worker, by config value. A config change clears it. */
export type LinearUserCache = Map<string, string>;

interface Targets {
  projects: Project[];
  fallbackProjectId: string;
  projectLeadAgentId: string;
}

/**
 * Paperclip project for an issue: a `projectMap` override wins, then the
 * project with the same name as the Linear project, then the fallback.
 * Adds the Linear project name to `unmatched` when no project has its name.
 */
function chooseProject(
  ctx: PluginContext,
  config: IntakeConfig,
  targets: Targets,
  issue: LinearIssue,
  unmatched: Set<string>,
): string {
  const project = issue.project;
  if (!project) return targets.fallbackProjectId;

  const override =
    config.projectMap.find((m) => m.linearProject === project.id) ??
    config.projectMap.find((m) => sameName(m.linearProject, project.name));
  if (override) {
    const match = matchProject(targets.projects, override.paperclipProject);
    if (match.kind === "one") return match.id;
    ctx.logger.warn("projectMap target is not one Paperclip project; using the fallback project", {
      key: issue.identifier,
      paperclipProject: override.paperclipProject,
      found: match.kind,
    });
    return targets.fallbackProjectId;
  }

  const byName = matchProject(targets.projects, project.name);
  if (byName.kind === "one") return byName.id;
  if (byName.kind === "many") {
    ctx.logger.warn("More than one Paperclip project has the Linear project name; using the fallback project", {
      key: issue.identifier,
      linearProject: project.name,
    });
  } else unmatched.add(project.name);
  return targets.fallbackProjectId;
}

async function resolveTargets(ctx: PluginContext, companyId: string, config: IntakeConfig): Promise<Targets> {
  const projects = await ctx.projects.list({ companyId });
  return {
    projects,
    fallbackProjectId: resolveProject(projects, config.fallbackProject, "fallbackProject"),
    projectLeadAgentId: await resolveAgent(ctx, companyId, config.projectLead, "projectLeadAgentId"),
  };
}

/**
 * One intake pass. Throws when Linear cannot be read or a config name cannot be
 * resolved (nothing is created), or when any single key failed after the rest
 * were processed, so the job run shows failed.
 */
export async function runIntake(
  ctx: PluginContext,
  companyId: string,
  config: IntakeConfig,
  userCache: LinearUserCache = new Map(),
): Promise<IntakeSummary> {
  const apiKey = await ctx.secrets.resolve(config.linearApiKey as never, { companyId, configPath: "linearApiKey" });
  const fetchImpl = (url: string, init?: RequestInit) => ctx.http.fetch(url, init);

  let userId = userCache.get(config.linearAgentUser);
  if (!userId) {
    try {
      userId = await resolveLinearUser(fetchImpl, apiKey, config.linearAgentUser);
    } catch (err) {
      ctx.logger.error("Linear agent user not resolved; intake skipped", { error: (err as Error).message });
      throw err;
    }
    userCache.set(config.linearAgentUser, userId);
  }

  let page;
  try {
    page = await fetchIntakeIssues(fetchImpl, apiKey, {
      teamKeys: config.teamKeys,
      userId,
      field: config.assignmentField,
    });
  } catch (err) {
    ctx.logger.error("Linear query failed; retrying next tick", { error: (err as Error).message });
    throw err;
  }
  if (page.hasNextPage) {
    ctx.logger.warn(
      "Linear has more Todo issues than one page; only the first page was read. The rest are read only after earlier issues leave Todo",
      { pageSize: page.issues.length },
    );
  }

  const summary: IntakeSummary = { fetched: page.issues.length, created: [], adopted: [], failed: [] };

  const fresh: LinearIssue[] = [];
  for (const issue of page.issues) {
    if ((await ctx.state.get(stateKey(companyId, issue.identifier))) == null) fresh.push(issue);
  }
  if (fresh.length === 0) return summary;

  const existing = await findTasksByKey(
    ctx,
    companyId,
    fresh.map((i) => i.identifier),
  );

  const toCreate: LinearIssue[] = [];
  for (const issue of fresh) {
    const key = issue.identifier;
    const existingId = existing.get(key);
    if (!existingId) {
      toCreate.push(issue);
      continue;
    }
    try {
      const record: IntakeRecord = { issueId: existingId, recordedAt: new Date().toISOString(), source: "existing" };
      await ctx.state.set(stateKey(companyId, key), record);
      summary.adopted.push(key);
      ctx.logger.info("Linear issue already has a task; recorded", { key, issueId: existingId });
    } catch (err) {
      summary.failed.push(key);
      ctx.logger.error("Linear intake failed for one issue", { key, error: (err as Error).message });
    }
  }

  if (toCreate.length > 0) {
    let targets: Targets;
    try {
      targets = await resolveTargets(ctx, companyId, config);
    } catch (err) {
      ctx.logger.error("Plugin config names no single project or agent; no task created", {
        error: (err as Error).message,
      });
      throw err;
    }
    const unmatched = new Set<string>();

    for (const issue of toCreate) {
      const key = issue.identifier;
      try {
        const projectId = chooseProject(ctx, config, targets, issue, unmatched);
        const task = await ctx.issues.create({
          companyId,
          projectId,
          title: taskTitle(issue),
          description: issue.url,
          assigneeAgentId: targets.projectLeadAgentId,
          originId: key,
        });
        const record: IntakeRecord = { issueId: task.id, recordedAt: new Date().toISOString(), source: "created" };
        let wakeError: unknown = null;
        try {
          await ctx.issues.requestWakeup(task.id, companyId, {
            reason: "linear_intake",
            idempotencyKey: `${STATE_NAMESPACE}:${key}:${task.id}`,
          });
        } catch (err) {
          wakeError = err;
        }
        await ctx.state.set(stateKey(companyId, key), record);
        summary.created.push(key);
        ctx.logger.info("Created Project Lead task for Linear issue", { key, issueId: task.id, projectId });
        if (wakeError) throw wakeError;
      } catch (err) {
        summary.failed.push(key);
        ctx.logger.error("Linear intake failed for one issue", { key, error: (err as Error).message });
      }
    }

    if (unmatched.size > 0) {
      ctx.logger.warn("No Paperclip project has these Linear project names; their tasks went to the fallback project", {
        linearProjects: [...unmatched],
      });
    }
  }

  if (summary.failed.length > 0) {
    throw new Error(`Linear intake failed for ${summary.failed.join(", ")}; see plugin logs`);
  }
  return summary;
}
