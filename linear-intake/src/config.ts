export type AssignmentField = "assignee" | "delegate";

export interface ProjectMapping {
  linearProject: string;
  paperclipProjectId: string;
}

export interface IntakeConfig {
  linearApiKey: Record<string, unknown>;
  linearAgentUserId: string;
  assignmentField: AssignmentField;
  teamKeys: string[];
  projectMap: ProjectMapping[];
  fallbackProjectId: string;
  projectLeadAgentId: string;
}

export const DEFAULT_TEAM_KEYS = ["M", "KNO"];
export const DEFAULT_PROJECT_LEAD_AGENT_ID = "e18b31d8-e737-4e89-8471-697d59b65453";

export type ParsedConfig = { ok: true; config: IntakeConfig } | { ok: false; errors: string[] };

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Normalize raw plugin config, applying defaults. Errors name the offending field. */
export function parseConfig(raw: Record<string, unknown>): ParsedConfig {
  const errors: string[] = [];

  const apiKey = raw.linearApiKey;
  const isSecretRef =
    typeof apiKey === "object" && apiKey !== null && (apiKey as { type?: unknown }).type === "secret_ref";
  if (!isSecretRef) errors.push("linearApiKey: choose a Paperclip secret");

  const linearAgentUserId = nonEmptyString(raw.linearAgentUserId);
  if (!linearAgentUserId) errors.push("linearAgentUserId: required");

  const fallbackProjectId = nonEmptyString(raw.fallbackProjectId);
  if (!fallbackProjectId) errors.push("fallbackProjectId: required");

  const projectLeadAgentId = nonEmptyString(raw.projectLeadAgentId ?? DEFAULT_PROJECT_LEAD_AGENT_ID);
  if (!projectLeadAgentId) errors.push("projectLeadAgentId: required");

  const assignmentField = raw.assignmentField ?? "assignee";
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
        const paperclipProjectId = nonEmptyString(e.paperclipProjectId);
        if (!linearProject || !paperclipProjectId) {
          errors.push(`projectMap[${i}]: needs linearProject and paperclipProjectId`);
        } else projectMap.push({ linearProject, paperclipProjectId });
      });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      linearApiKey: apiKey as Record<string, unknown>,
      linearAgentUserId: linearAgentUserId!,
      assignmentField: assignmentField as AssignmentField,
      teamKeys,
      projectMap,
      fallbackProjectId: fallbackProjectId!,
      projectLeadAgentId: projectLeadAgentId!,
    },
  };
}
