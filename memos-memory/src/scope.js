// Memory scopes. The default scope is company + project. Sharing is opt-in,
// set on the plugin's settings page, and never crosses companies: sharing
// settings are stored per company and only name that company's projects.

export const UNSCOPED_PROJECT = "unscoped";
export const ALL_READERS = "all";

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
 * Normalize stored or submitted sharing settings to
 * `[{ projectId, projectName, readers: "all" | string[] }]`. A share with no
 * readers is dropped: it shares nothing. Invalid entries are reported through
 * `onInvalid` and dropped. When `knownProjects` (id → name) is given, shares
 * and readers outside it are dropped, so only this company's projects remain.
 */
export function normalizeShares(input, { knownProjects = null, onInvalid = () => {} } = {}) {
  const list = Array.isArray(input) ? input : Array.isArray(input?.shares) ? input.shares : [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const projectId = clean(entry?.projectId);
    if (!projectId || seen.has(projectId)) {
      if (!projectId) onInvalid("a share needs a projectId");
      continue;
    }
    if (knownProjects && !knownProjects.has(projectId)) {
      onInvalid(`project ${projectId} is not in this company`);
      continue;
    }
    let readers;
    if (entry.readers === ALL_READERS || (Array.isArray(entry.readers) && entry.readers.includes(ALL_READERS))) {
      readers = ALL_READERS;
    } else if (Array.isArray(entry.readers)) {
      readers = [...new Set(entry.readers.map(clean).filter((r) => r && r !== projectId && (!knownProjects || knownProjects.has(r))))];
      if (readers.length === 0) continue;
    } else {
      onInvalid(`share for ${projectId} has no readers list`);
      continue;
    }
    seen.add(projectId);
    const projectName = clean(knownProjects?.get(projectId)) ?? clean(entry.projectName) ?? projectId;
    out.push({ projectId, projectName, readers });
  }
  return out;
}

/** Shares a reader project may read: `[{ projectId, projectName }]`, own project excluded. */
export function readableShares({ projectId, shares = [] }) {
  const own = clean(projectId) ?? UNSCOPED_PROJECT;
  return shares
    .filter((s) => s.projectId !== own && (s.readers === ALL_READERS || (Array.isArray(s.readers) && s.readers.includes(own))))
    .map((s) => ({ projectId: s.projectId, projectName: s.projectName ?? s.projectId }));
}

/**
 * Scopes a reader may recall from: its own company+project scope first, then
 * the shared projects it may read, in the SAME company, labelled with their
 * source project name.
 */
export function recallScopes({ companyId, projectId, shared = [] }) {
  const own = scopeFor({ companyId, projectId });
  const scopes = [own];
  const seen = new Set([own.key]);
  for (const s of shared) {
    const scope = { ...scopeFor({ companyId: own.companyId, projectId: s.projectId }), shared: true, projectName: s.projectName ?? s.projectId };
    if (seen.has(scope.key)) continue;
    seen.add(scope.key);
    scopes.push(scope);
  }
  return scopes;
}
