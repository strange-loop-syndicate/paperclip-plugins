export type AssignmentField = "assignee" | "delegate";

/** A projectMap override: Linear project (id or name) -> Paperclip project (name or id). */
export interface ProjectMapping {
  linearProject: string;
  paperclipProject: string;
}

export interface IntakeConfig {
  linearApiKey: Record<string, unknown>;
  /** Linear user name, display name, email or id. */
  linearAgentUser: string;
  assignmentField: AssignmentField;
  teamKeys: string[];
  projectMap: ProjectMapping[];
  /** Paperclip project name or id. */
  fallbackProject: string;
  /** Paperclip agent id or name. */
  projectLead: string;
  /** Paperclip agent id or name, recorded as the task's creator. */
  creatorAgent: string;
}

export const DEFAULT_LINEAR_AGENT_USER = "Claude Code";
export const DEFAULT_ASSIGNMENT_FIELD: AssignmentField = "delegate";
export const DEFAULT_TEAM_KEYS = ["M", "KNO"];
export const DEFAULT_FALLBACK_PROJECT = "Ops";
export const DEFAULT_PROJECT_LEAD_AGENT_ID = "e18b31d8-e737-4e89-8471-697d59b65453";
export const DEFAULT_CREATOR_AGENT = "Project Director";

export type ParsedConfig = { ok: true; config: IntakeConfig } | { ok: false; errors: string[] };

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Normalize raw plugin config, applying defaults. Errors name the offending field.
 * The new name-or-id fields win; the old id fields (`linearAgentUserId`,
 * `fallbackProjectId`, `projectMap[].paperclipProjectId`) are read when the new
 * field is absent, so a config saved before the rename keeps working.
 */
export function parseConfig(raw: Record<string, unknown>): ParsedConfig {
  const errors: string[] = [];

  const apiKey = raw.linearApiKey;
  const isSecretRef =
    typeof apiKey === "object" && apiKey !== null && (apiKey as { type?: unknown }).type === "secret_ref";
  if (!isSecretRef) errors.push("linearApiKey: choose a Paperclip secret");

  const linearAgentUser =
    nonEmptyString(raw.linearAgentUser) ?? nonEmptyString(raw.linearAgentUserId) ?? DEFAULT_LINEAR_AGENT_USER;
  const fallbackProject =
    nonEmptyString(raw.fallbackProject) ?? nonEmptyString(raw.fallbackProjectId) ?? DEFAULT_FALLBACK_PROJECT;
  const projectLead = nonEmptyString(raw.projectLeadAgentId) ?? DEFAULT_PROJECT_LEAD_AGENT_ID;
  const creatorAgent = nonEmptyString(raw.creatorAgent) ?? DEFAULT_CREATOR_AGENT;

  const assignmentField = raw.assignmentField ?? DEFAULT_ASSIGNMENT_FIELD;
  if (assignmentField !== "assignee" && assignmentField !== "delegate") {
    errors.push("assignmentField: must be assignee or delegate");
  }

  let teamKeys = DEFAULT_TEAM_KEYS;
  if (raw.teamKeys !== undefined) {
    const keys = Array.isArray(raw.teamKeys) ? raw.teamKeys.map(nonEmptyString) : [null];
    if (keys.length === 0 || keys.some((k) => k === null)) errors.push("teamKeys: list of non-empty team keys");
    else teamKeys = keys as string[];
  }

  const projectMap: ProjectMapping[] = [];
  if (raw.projectMap !== undefined) {
    if (!Array.isArray(raw.projectMap)) errors.push("projectMap: must be a list");
    else
      raw.projectMap.forEach((entry, i) => {
        const e = (entry ?? {}) as Record<string, unknown>;
        const linearProject = nonEmptyString(e.linearProject);
        const paperclipProject = nonEmptyString(e.paperclipProject) ?? nonEmptyString(e.paperclipProjectId);
        if (!linearProject || !paperclipProject) {
          errors.push(`projectMap[${i}]: needs linearProject and paperclipProject`);
        } else projectMap.push({ linearProject, paperclipProject });
      });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      linearApiKey: apiKey as Record<string, unknown>,
      linearAgentUser,
      assignmentField: assignmentField as AssignmentField,
      teamKeys,
      projectMap,
      fallbackProject,
      projectLead,
      creatorAgent,
    },
  };
}
