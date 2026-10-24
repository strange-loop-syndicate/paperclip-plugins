// Pre-prompt recall: runs BEFORE the agent CLI starts, under one hard deadline.
// Any failure (no config, Paperclip API down, MemOS down/slow/5xx) yields "".

import { normalizeContent } from "../content.js";
import { formatMemoryBlock, DEFAULT_MAX_BLOCK_CHARS } from "../format.js";
import { createMemosClient, recallAcrossScopes, DEFAULT_RECALL_TIMEOUT_MS, DEFAULT_TOP_K } from "../memos-client.js";
import { parseSharedScopes, recallScopes } from "../scope.js";

const QUERY_MAX_CHARS = 1000;
// Recall delays every CLI start while MemOS is down, so the budget is capped:
// a config typo like 30000 cannot turn into a 30 s stall.
export const MAX_RECALL_TIMEOUT_MS = DEFAULT_RECALL_TIMEOUT_MS;

function positiveInt(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function readWrapperConfig(env) {
  return {
    disabled: env.MEMOS_RECALL_DISABLED === "1" || env.MEMOS_RECALL_DISABLED === "true",
    baseUrl: env.MEMOS_BASE_URL ?? "",
    apiKey: env.MEMOS_API_KEY || null,
    timeoutMs: Math.min(positiveInt(env.MEMOS_RECALL_TIMEOUT_MS, DEFAULT_RECALL_TIMEOUT_MS), MAX_RECALL_TIMEOUT_MS),
    topK: positiveInt(env.MEMOS_TOP_K, DEFAULT_TOP_K),
    maxBlockChars: positiveInt(env.MEMOS_MAX_BLOCK_CHARS, DEFAULT_MAX_BLOCK_CHARS),
    sharedScopes: env.MEMOS_SHARED_SCOPES ?? "",
    paperclipApiUrl: (env.PAPERCLIP_API_URL ?? "").replace(/\/+$/, "").replace(/\/api$/, ""),
    paperclipApiKey: env.PAPERCLIP_API_KEY ?? "",
    companyId: env.PAPERCLIP_COMPANY_ID ?? "",
    agentId: env.PAPERCLIP_AGENT_ID ?? "",
    taskId: env.PAPERCLIP_TASK_ID ?? "",
  };
}

async function fetchIssue({ cfg, fetchImpl, signal }) {
  const res = await fetchImpl(`${cfg.paperclipApiUrl}/api/issues/${encodeURIComponent(cfg.taskId)}`, {
    headers: { authorization: `Bearer ${cfg.paperclipApiKey}`, accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`issue lookup HTTP ${res.status}`);
  return res.json();
}

/**
 * Returns { block, memories, reason }. `block` is "" whenever recall is
 * skipped or fails; `reason` says why, for one log line. The budget counts
 * from `startedAt` (the wrapper's entry), so wrapper work before recall is
 * inside it.
 */
export async function recallForRun({ env, fetchImpl = globalThis.fetch, logger = { warn() {} }, startedAt = Date.now() }) {
  const cfg = readWrapperConfig(env);
  if (cfg.disabled) return { block: "", memories: [], reason: "disabled" };
  if (!cfg.baseUrl) return { block: "", memories: [], reason: "MEMOS_BASE_URL not set" };
  if (!cfg.companyId || !cfg.taskId || !cfg.paperclipApiUrl) return { block: "", memories: [], reason: "no Paperclip task context" };

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`recall deadline ${cfg.timeoutMs}ms`)), Math.max(1, cfg.timeoutMs - (Date.now() - startedAt)));
  try {
    const issue = await fetchIssue({ cfg, fetchImpl, signal: deadline.signal });
    if (!issue || issue.companyId !== cfg.companyId) return { block: "", memories: [], reason: "issue not in this company" };

    const query = [issue.identifier, issue.title, issue.description].filter(Boolean).join("\n").slice(0, QUERY_MAX_CHARS);
    const sharedScopes = parseSharedScopes(cfg.sharedScopes, (msg) => logger.warn(`ignoring invalid MEMOS_SHARED_SCOPES: ${msg}`));
    const scopes = recallScopes({ companyId: cfg.companyId, projectId: issue.projectId, agentId: cfg.agentId, sharedScopes });
    const remaining = Math.max(1, cfg.timeoutMs - (Date.now() - startedAt));
    const client = createMemosClient({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      logger,
      fetchImpl: (url, init) => {
        // Chain the outer deadline into each MemOS call.
        const signal = init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
        return fetchImpl(url, { ...init, signal });
      },
    });
    const memories = await recallAcrossScopes({ client, scopes, query, topK: cfg.topK, timeoutMs: remaining, normalize: normalizeContent });
    const block = formatMemoryBlock(memories, { maxChars: cfg.maxBlockChars });
    return { block, memories, reason: memories.length ? `recalled ${memories.length}` : "no memories" };
  } catch (err) {
    logger.warn(`recall skipped: ${err.message}`);
    return { block: "", memories: [], reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}
