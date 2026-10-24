// Memory scopes. The default scope is company + project. A recall never reads
// a scope from another company, even if the sharing allowlist names one.

export const UNSCOPED_PROJECT = "unscoped";

function clean(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Build the storage scope for one company + project pair. */
export function scopeFor({ companyId, projectId }) {
  const company = clean(companyId);
  if (!company) throw new Error("scopeFor: companyId is required");
  const project = clean(projectId) ?? UNSCOPED_PROJECT;
  return {
    companyId: company,
    projectId: project,
    key: `${company}/${project}`,
    // MemOS identifiers: one MemOS user per company, one cube per project.
    userId: `paperclip-${company}`,
    cubeId: `paperclip-${company}-${project}`,
  };
}

/**
 * Parse the sharing allowlist. Accepts an array or a JSON string of
 * `{ companyId, projectId, readerProjectIds?, readerAgentIds? }` entries.
 * Invalid entries are dropped and reported through `onInvalid`.
 */
export function parseSharedScopes(input, onInvalid = () => {}) {
  let list = input;
  if (typeof list === "string") {
    if (list.trim() === "") return [];
    try {
      list = JSON.parse(list);
    } catch {
      onInvalid("sharedScopes is not valid JSON");
      return [];
    }
  }
  if (list == null) return [];
  if (!Array.isArray(list)) {
    onInvalid("sharedScopes must be an array");
    return [];
  }
  const out = [];
  for (const entry of list) {
    const companyId = clean(entry?.companyId);
    const projectId = clean(entry?.projectId);
    if (!companyId || !projectId) {
      onInvalid("sharedScopes entry needs companyId and projectId");
      continue;
    }
    const readerProjectIds = Array.isArray(entry.readerProjectIds) ? entry.readerProjectIds.map(clean).filter(Boolean) : null;
    const readerAgentIds = Array.isArray(entry.readerAgentIds) ? entry.readerAgentIds.map(clean).filter(Boolean) : null;
    out.push({ companyId, projectId, readerProjectIds, readerAgentIds });
  }
  return out;
}

/**
 * Scopes a reader may recall from: its own company+project scope first, then
 * any allowlisted scopes in the SAME company whose reader lists admit it.
 */
export function recallScopes({ companyId, projectId, agentId, sharedScopes = [] }) {
  const own = scopeFor({ companyId, projectId });
  const scopes = [own];
  const seen = new Set([own.key]);
  for (const entry of sharedScopes) {
    if (entry.companyId !== own.companyId) continue;
    if (entry.readerProjectIds && !entry.readerProjectIds.includes(own.projectId)) continue;
    if (entry.readerAgentIds && !entry.readerAgentIds.includes(clean(agentId))) continue;
    const scope = scopeFor(entry);
    if (seen.has(scope.key)) continue;
    seen.add(scope.key);
    scopes.push(scope);
  }
  return scopes;
}
