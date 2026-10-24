// Minimal MemOS HTTP client. Every call has a hard timeout and fails open:
// search returns no memories and add returns { ok: false }, with a warning.
//
// The request/response mapping targets the MemOS product API
// (POST /product/search, POST /product/add). Paths are configurable; the
// response parser accepts the shapes MemOS versions are known to return.

export const DEFAULT_RECALL_TIMEOUT_MS = 3000;
export const DEFAULT_CAPTURE_TIMEOUT_MS = 5000;
export const DEFAULT_TOP_K = 8;

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

async function postJson({ fetchImpl, url, body, apiKey, timeoutMs, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const onOuterAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onOuterAbort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  // Race every await against the abort, so the deadline holds even if
  // fetchImpl ignores init.signal.
  const aborted = new Promise((_, reject) => {
    const fail = () => reject(controller.signal.reason ?? new Error("aborted"));
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => {});
  try {
    const headers = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await Promise.race([fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal }), aborted]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await Promise.race([res.json(), aborted]);
    if (json && typeof json.code === "number" && json.code !== 200 && json.code !== 0) {
      throw new Error(`MemOS code ${json.code}: ${json.message ?? "error"}`);
    }
    return json;
  } catch (err) {
    if (controller.signal.aborted) throw new Error(String(controller.signal.reason?.message ?? "aborted"));
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

function toMemory(item) {
  if (typeof item === "string") return { content: item, metadata: {} };
  if (!item || typeof item !== "object") return null;
  const content = item.memory ?? item.memory_content ?? item.content ?? item.text;
  if (typeof content !== "string" || content.trim() === "") return null;
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
  // The add-time `info` may come back top-level, merged into metadata, or
  // nested as metadata.info, depending on the MemOS version.
  const metadata = { ...obj(item.metadata), ...obj(item.metadata?.info), ...obj(item.info) };
  delete metadata.info;
  return { content, metadata };
}

/**
 * The IDs of the memories an add created. MemOS 2.0.33 answers
 * `{ data: [{ memory, memory_id, memory_type, cube_id }] }`, and answers 200
 * with `data: []` when it stored nothing (for example when the embedder
 * fails: "No add/update items prepared").
 */
export function addedMemoryIds(json) {
  const data = json?.data;
  if (!Array.isArray(data)) return [];
  return data.map((item) => item?.memory_id).filter((id) => typeof id === "string" && id !== "");
}

/** Pull memory items out of the known MemOS search response shapes. */
export function parseSearchResponse(json) {
  const data = json?.data ?? json;
  const items = [];
  if (Array.isArray(data?.text_mem)) {
    for (const bucket of data.text_mem) {
      if (Array.isArray(bucket?.memories)) items.push(...bucket.memories);
    }
  } else if (Array.isArray(data?.memories)) {
    items.push(...data.memories);
  } else if (Array.isArray(data)) {
    items.push(...data);
  }
  return items.map(toMemory).filter(Boolean);
}

export function createMemosClient({ baseUrl, apiKey = null, fetchImpl = globalThis.fetch, logger = console, searchPath = "/product/search", addPath = "/product/add" }) {
  const configured = typeof baseUrl === "string" && baseUrl.trim() !== "";

  return {
    configured,

    /**
     * Search one scope. Never throws. Keeps only results whose metadata names
     * this company, and drops any that name a different MemOS user (defence in
     * depth on top of per-company MemOS users). MemOS 2.0.33 echoes the
     * add-time `info` in `metadata`, so a result with no company is not ours.
     */
    async search({ scope, query, topK = DEFAULT_TOP_K, timeoutMs = DEFAULT_RECALL_TIMEOUT_MS, signal }) {
      if (!configured) return [];
      try {
        const json = await postJson({
          fetchImpl,
          url: joinUrl(baseUrl, searchPath),
          apiKey,
          timeoutMs,
          signal,
          body: { query, user_id: scope.userId, mem_cube_id: scope.cubeId, top_k: topK },
        });
        return parseSearchResponse(json)
          .filter((m) => m.metadata.companyId === scope.companyId)
          .filter((m) => m.metadata.user_id == null || m.metadata.user_id === scope.userId)
          .map((m) => ({ ...m, scopeKey: scope.key }));
      } catch (err) {
        logger.warn?.(`memos search failed; continuing with no memories (${err.message})`, { scope: scope.key });
        return [];
      }
    },

    /**
     * Add one memory to a scope. Never throws. Sync + fast stores the text as
     * given, with its `info`. The default async add has an LLM rewrite the
     * text later, and the rewritten memory loses `info` (checked live in
     * SLS-63), so recall could no longer filter it by company.
     * Only an answer that names created memory IDs counts as stored; the
     * error never carries the memory text MemOS echoes back.
     */
    async add({ scope, content, metadata = {}, timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS, signal }) {
      if (!configured) return { ok: false, error: "memos not configured" };
      let json;
      try {
        json = await postJson({
          fetchImpl,
          url: joinUrl(baseUrl, addPath),
          apiKey,
          timeoutMs,
          signal,
          body: {
            user_id: scope.userId,
            mem_cube_id: scope.cubeId,
            memory_content: content,
            async_mode: "sync",
            mode: "fast",
            source: "paperclip",
            info: { ...metadata, companyId: scope.companyId, projectId: scope.projectId },
          },
        });
      } catch (err) {
        logger.warn?.(`memos add failed; memory not stored (${err.message})`, { scope: scope.key });
        return { ok: false, error: err.message };
      }
      const memoryIds = addedMemoryIds(json);
      if (memoryIds.length === 0) {
        const error = "MemOS answered with no created memory IDs";
        logger.warn?.(`memos add failed; memory not stored (${error})`, { scope: scope.key });
        return { ok: false, error };
      }
      return { ok: true, memoryIds };
    },
  };
}

// Recall order by memory type: decisions and lessons first, then outcomes and
// facts, then anything else (older v1 memories, `note`).
const TYPE_RANK = { decision: 0, lesson: 0, outcome: 1, fact: 1 };
export function typeRank(kind) {
  return TYPE_RANK[kind] ?? 2;
}

/**
 * Recall across several scopes under ONE deadline. Returns at most `topK`
 * memories, duplicates (by normalized text) removed, ordered by type rank;
 * within a rank, own scope first, then search order. Memories from a shared
 * scope carry `sharedFrom` (the source project name).
 */
export async function recallAcrossScopes({ client, scopes, query, topK = DEFAULT_TOP_K, timeoutMs = DEFAULT_RECALL_TIMEOUT_MS, normalize }) {
  if (!client.configured || !query || scopes.length === 0) return [];
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`recall deadline ${timeoutMs}ms`)), timeoutMs);
  try {
    const perScope = await Promise.all(scopes.map((scope) => client.search({ scope, query, topK, timeoutMs, signal: deadline.signal })));
    const seen = new Set();
    const all = [];
    perScope.forEach((memories, scopeIndex) => {
      const scope = scopes[scopeIndex];
      for (const m of memories) {
        const k = normalize(m.content);
        if (seen.has(k)) continue;
        seen.add(k);
        all.push({ ...m, ...(scope.shared ? { sharedFrom: scope.projectName ?? scope.projectId } : {}), order: all.length });
      }
    });
    return all
      .sort((a, b) => typeRank(a.metadata.kind) - typeRank(b.metadata.kind) || a.order - b.order)
      .slice(0, topK)
      .map(({ order, ...m }) => m);
  } finally {
    clearTimeout(timer);
  }
}
