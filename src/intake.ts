import type { PluginContext, ScopeKey } from "@paperclipai/plugin-sdk";
import type { IntakeConfig } from "./config.ts";
import { fetchIntakeIssues, type LinearIssue } from "./linear.ts";

export const JOB_KEY = "linear-intake";
export const STATE_NAMESPACE = "linear-intake";
const ISSUE_PAGE_SIZE = 500;

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

/** Map key -> id of the first Paperclip task whose title starts with `[KEY]`, any status. */
async function findTasksByKey(ctx: PluginContext, companyId: string, keys: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const prefixes = keys.map((key) => ({ key, prefix: `[${key}]` }));
  for (let offset = 0; ; offset += ISSUE_PAGE_SIZE) {
    const page = await ctx.issues.list({ companyId, limit: ISSUE_PAGE_SIZE, offset });
    for (const task of page) {
      for (const { key, prefix } of prefixes) {
        if (!found.has(key) && task.title.startsWith(prefix)) found.set(key, task.id);
      }
    }
    if (page.length < ISSUE_PAGE_SIZE || found.size === keys.length) return found;
  }
}

function mappedProjectId(config: IntakeConfig, issue: LinearIssue): string | null {
  const project = issue.project;
  if (!project) return null;
  const byId = config.projectMap.find((m) => m.linearProject === project.id);
  const byName = config.projectMap.find((m) => m.linearProject.toLowerCase() === project.name.toLowerCase());
  return (byId ?? byName)?.paperclipProjectId ?? null;
}

/**
 * One intake pass. Throws when Linear cannot be read (nothing is created) or when
 * any single key failed after the rest were processed, so the job run shows failed.
 */
export async function runIntake(ctx: PluginContext, companyId: string, config: IntakeConfig): Promise<IntakeSummary> {
  const apiKey = await ctx.secrets.resolve(config.linearApiKey as never, { companyId, configPath: "linearApiKey" });

  let page;
  try {
    page = await fetchIntakeIssues((url, init) => ctx.http.fetch(url, init), apiKey, {
      teamKeys: config.teamKeys,
      userId: config.linearAgentUserId,
      field: config.assignmentField,
    });
  } catch (err) {
    ctx.logger.error("Linear query failed; retrying next tick", { error: (err as Error).message });
    throw err;
  }
  if (page.hasNextPage) {
    ctx.logger.warn("Linear returned more than one page of Todo issues; the rest are taken next ticks");
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
  const projectExists = new Map<string, boolean>();

  for (const issue of fresh) {
    const key = issue.identifier;
    try {
      const existingId = existing.get(key);
      if (existingId) {
        const record: IntakeRecord = { issueId: existingId, recordedAt: new Date().toISOString(), source: "existing" };
        await ctx.state.set(stateKey(companyId, key), record);
        summary.adopted.push(key);
        ctx.logger.info("Linear issue already has a task; recorded", { key, issueId: existingId });
        continue;
      }

      let projectId = mappedProjectId(config, issue) ?? config.fallbackProjectId;
      if (!projectExists.has(projectId)) {
        projectExists.set(projectId, (await ctx.projects.get(projectId, companyId)) !== null);
      }
      if (!projectExists.get(projectId) && projectId !== config.fallbackProjectId) {
        ctx.logger.warn("Mapped Paperclip project not found; using the fallback project", { key, projectId });
        projectId = config.fallbackProjectId;
      }

      const task = await ctx.issues.create({
        companyId,
        projectId,
        title: taskTitle(issue),
        description: issue.url,
        assigneeAgentId: config.projectLeadAgentId,
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

  if (summary.failed.length > 0) {
    throw new Error(`Linear intake failed for ${summary.failed.join(", ")}; see plugin logs`);
  }
  return summary;
}
