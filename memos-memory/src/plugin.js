// Plugin behaviour: capture on agent.run.finished and agent comments, dedup by
// normalized-content hash per scope, and the memory_recall / memory_retain tools.
// Nothing here can fail or delay a run: event delivery is fire-and-forget on
// the host, and every handler swallows its own errors.

import { definePlugin } from "@paperclipai/plugin-sdk";
import { contentHash, normalizeContent } from "./content.js";
import { buildRunOutcome, extractMemories } from "./extract.js";
import { formatMemoryLine } from "./format.js";
import { createMemosClient, recallAcrossScopes, DEFAULT_CAPTURE_TIMEOUT_MS, DEFAULT_RECALL_TIMEOUT_MS, DEFAULT_TOP_K } from "./memos-client.js";
import { parseSharedScopes, recallScopes, scopeFor, UNSCOPED_PROJECT } from "./scope.js";

const DEDUP_NAMESPACE = "memos-dedup";
const HOST_CALL_TIMEOUT_MS = 5000;
const MAX_MEMORIES_PER_COMMENT = 20;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function num(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// MemOS is called with the worker's own fetch, not ctx.http.fetch: the host
// fetch refuses loopback/private addresses (where self-hosted MemOS lives) and
// drops the abort signal, so timeouts would not hold. The URL is operator
// config, not agent input.
export function createMemoryPlugin({ fetchImpl = (url, init) => globalThis.fetch(url, init) } = {}) {
  // Concurrent redelivery inside this worker process shares one in-flight
  // write; ctx.state guards redelivery across time and restarts.
  const inflight = new Map();

  async function loadConfig(ctx, companyId) {
    const raw = (await ctx.config.get(companyId)) ?? {};
    let apiKey = null;
    if (typeof raw.memosApiKeyRef === "string" && raw.memosApiKeyRef.trim() !== "") {
      try {
        apiKey = await ctx.secrets.resolve(raw.memosApiKeyRef);
      } catch (err) {
        ctx.logger.warn("memos api key secret could not be resolved; calling MemOS without auth", { error: err.message });
      }
    }
    return {
      client: createMemosClient({
        baseUrl: raw.memosBaseUrl,
        apiKey,
        fetchImpl,
        logger: ctx.logger,
      }),
      recallTimeoutMs: num(raw.recallTimeoutMs, DEFAULT_RECALL_TIMEOUT_MS),
      captureTimeoutMs: num(raw.captureTimeoutMs, DEFAULT_CAPTURE_TIMEOUT_MS),
      topK: num(raw.topK, DEFAULT_TOP_K),
      captureComments: raw.captureComments !== false,
      captureRunOutcomes: raw.captureRunOutcomes !== false,
      sharedScopes: parseSharedScopes(raw.sharedScopes, (msg) => ctx.logger.warn(`ignoring invalid sharing config: ${msg}`)),
      captureProjectIds: Array.isArray(raw.captureProjectIds) ? raw.captureProjectIds.filter((p) => typeof p === "string" && p !== "") : [],
    };
  }

  /** An empty `captureProjectIds` stores for every project; a list stores only for those. */
  function captureAllowed(cfg, projectId) {
    return cfg.captureProjectIds.length === 0 || cfg.captureProjectIds.includes(projectId ?? UNSCOPED_PROJECT);
  }

  /**
   * Store one memory unless the same normalized content was already stored in
   * this scope. An optional `dedupKey` (e.g. the run ID) is checked as well,
   * so a redelivered event whose content changed is still a duplicate.
   * Returns { status: "stored" | "duplicate" | "failed", contentHash }.
   */
  async function retain(ctx, cfg, { scope, content, metadata, dedupKey }) {
    const hash = contentHash(content);
    const stateKeys = [hash, dedupKey].filter(Boolean).map((k) => ({
      scopeKind: "company",
      scopeId: scope.companyId,
      namespace: DEDUP_NAMESPACE,
      stateKey: `${scope.projectId}:${k}`,
    }));
    const lockKeys = stateKeys.map((k) => `${scope.key}:${k.stateKey}`);
    const pending = lockKeys.map((k) => inflight.get(k)).find(Boolean);
    if (pending) {
      // Report what the concurrent write actually did, not a guess.
      const first = await pending;
      return { status: first.status === "failed" ? "failed" : "duplicate", contentHash: hash };
    }
    const work = (async () => {
      for (const key of stateKeys) {
        if (await ctx.state.get(key)) return { status: "duplicate", contentHash: hash };
      }
      const fullMetadata = { ...metadata, companyId: scope.companyId, projectId: scope.projectId, contentHash: hash };
      const res = await cfg.client.add({ scope, content, metadata: fullMetadata, timeoutMs: cfg.captureTimeoutMs });
      if (!res.ok) return { status: "failed", contentHash: hash };
      const marker = { storedAt: new Date().toISOString(), kind: metadata.kind ?? null, runId: metadata.runId ?? null };
      // The memory is already in MemOS, so report it stored. Without the
      // marker a redelivered event can store it again (see SETUP.md, limits).
      try {
        for (const key of stateKeys) await ctx.state.set(key, marker);
      } catch (err) {
        ctx.logger.warn(`dedup marker not saved; a redelivered event may store this memory again: ${err.message}`, { contentHash: hash });
      }
      return { status: "stored", contentHash: hash };
    })();
    for (const k of lockKeys) inflight.set(k, work);
    try {
      return await work;
    } finally {
      for (const k of lockKeys) inflight.delete(k);
    }
  }

  async function loadIssue(ctx, issueId, companyId) {
    if (!issueId) return null;
    const issue = await withTimeout(ctx.issues.get(issueId, companyId), HOST_CALL_TIMEOUT_MS, "issues.get");
    // Never trust an issue from another company, whatever the host returns.
    return issue && issue.companyId === companyId ? issue : null;
  }

  async function loadComments(ctx, issueId, companyId) {
    const comments = await withTimeout(ctx.issues.listComments(issueId, companyId), HOST_CALL_TIMEOUT_MS, "issues.listComments");
    return (comments ?? []).filter((c) => c.companyId === companyId && !c.deletedAt);
  }

  function safe(ctx, label, fn) {
    return async (event) => {
      try {
        await fn(event);
      } catch (err) {
        ctx.logger.warn(`${label} capture skipped: ${err.message}`, { eventId: event?.eventId });
      }
    };
  }

  async function onRunFinished(ctx, event) {
    const { companyId } = event;
    const { runId, agentId, issueId } = event.payload ?? {};
    if (!runId || !issueId) return;
    const cfg = await loadConfig(ctx, companyId);
    if (!cfg.captureRunOutcomes || !cfg.client.configured) return;
    const issue = await loadIssue(ctx, issueId, companyId);
    if (!issue || !captureAllowed(cfg, issue.projectId)) return;
    const comments = await loadComments(ctx, issueId, companyId);
    // The host lists comments newest first; sort explicitly rather than rely on it.
    const runComments = comments
      .filter((c) => (c.createdByRunId ?? c.derivedCreatedByRunId) === runId && c.authorType === "agent")
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || String(a.id).localeCompare(String(b.id)));
    const summary = runComments.length > 0 ? runComments[runComments.length - 1].body : "";
    const content = buildRunOutcome({ issue, summary });
    const scope = scopeFor({ companyId, projectId: issue.projectId });
    await retain(ctx, cfg, {
      scope,
      content,
      // Content hash dedups identical outcomes across runs; the run key keeps a
      // redelivered event with a changed issue status idempotent.
      dedupKey: `run-${runId}`,
      metadata: { kind: "outcome", agentId: agentId ?? null, issueId, issueIdentifier: issue.identifier ?? null, runId, source: "agent.run.finished" },
    });
  }

  async function onCommentCreated(ctx, event) {
    const { companyId } = event;
    const payload = event.payload ?? {};
    const agentId = payload.agentId ?? (event.actorType === "agent" ? event.actorId : null);
    if (event.actorType !== "agent" || !agentId) return; // agent comments only
    const issueId = event.entityId;
    const commentId = payload.commentId;
    if (!issueId || !commentId) return;
    const cfg = await loadConfig(ctx, companyId);
    if (!cfg.captureComments || !cfg.client.configured) return;
    const issue = await loadIssue(ctx, issueId, companyId);
    if (!issue || !captureAllowed(cfg, issue.projectId)) return;
    const comment =(await loadComments(ctx, issueId, companyId)).find((c) => c.id === commentId);
    if (!comment || comment.authorType !== "agent") return;
    const memories = extractMemories(comment.body);
    if (memories.length === 0) return;
    const scope = scopeFor({ companyId, projectId: issue.projectId });
    // In parallel, so a comment with many markers stays near one capture
    // timeout (the host's onEvent RPC gives up after 30 s); one failure does
    // not skip the rest.
    const results = await Promise.allSettled(
      memories.slice(0, MAX_MEMORIES_PER_COMMENT).map((m) =>
        retain(ctx, cfg, {
          scope,
          content: m.content,
          metadata: {
            kind: m.kind,
            agentId,
            issueId,
            issueIdentifier: issue.identifier ?? null,
            runId: payload.runId ?? comment.createdByRunId ?? null,
            commentId,
            source: "issue.comment.created",
          },
        }),
      ),
    );
    for (const r of results) {
      if (r.status === "rejected") ctx.logger.warn(`comment memory skipped: ${r.reason?.message ?? r.reason}`, { eventId: event.eventId });
    }
  }

  async function memoryRecall(ctx, params, runCtx) {
    const query = typeof params?.query === "string" ? params.query.trim() : "";
    if (!query) return { error: "query is required" };
    const cfg = await loadConfig(ctx, runCtx.companyId);
    const limit = Math.min(num(params.limit, cfg.topK), 20);
    const scopes = recallScopes({ companyId: runCtx.companyId, projectId: runCtx.projectId, agentId: runCtx.agentId, sharedScopes: cfg.sharedScopes });
    const memories = await recallAcrossScopes({ client: cfg.client, scopes, query, topK: limit, timeoutMs: cfg.recallTimeoutMs, normalize: normalizeContent });
    if (memories.length === 0) return { content: "No relevant memories found.", data: { memories: [] } };
    return {
      content: memories.map(formatMemoryLine).join("\n"),
      data: { memories: memories.map((m) => ({ content: m.content, scope: m.scopeKey, kind: m.metadata.kind ?? null, issueIdentifier: m.metadata.issueIdentifier ?? null })) },
    };
  }

  async function memoryRetain(ctx, params, runCtx) {
    const content = typeof params?.content === "string" ? params.content.trim() : "";
    if (content.length < 3) return { error: "content is required" };
    const kind = ["decision", "lesson", "outcome", "note"].includes(params.kind) ? params.kind : "note";
    const cfg = await loadConfig(ctx, runCtx.companyId);
    let issue = null;
    if (typeof params.issueId === "string" && params.issueId) {
      issue = await loadIssue(ctx, params.issueId, runCtx.companyId).catch(() => null);
    }
    // Writes never move: the memory goes to the run's own project. An issue
    // from another project is refused, so naming one cannot write there.
    const scope = scopeFor({ companyId: runCtx.companyId, projectId: runCtx.projectId });
    if (issue && scopeFor({ companyId: runCtx.companyId, projectId: issue.projectId }).key !== scope.key) {
      return { error: "That issue belongs to another project; the memory was not stored.", data: { status: "rejected" } };
    }
    if (!captureAllowed(cfg, runCtx.projectId)) {
      return { error: "Memory capture is off for this project; the memory was not stored.", data: { status: "rejected" } };
    }
    const res = await retain(ctx, cfg, {
      scope,
      content,
      metadata: { kind, agentId: runCtx.agentId, runId: runCtx.runId, issueId: issue?.id ?? null, issueIdentifier: issue?.identifier ?? null, source: "memory_retain" },
    });
    const message = { stored: "Memory stored.", duplicate: "Already stored; nothing changed.", failed: "Memory service unavailable; the memory was not stored." }[res.status];
    return { content: message, data: res };
  }

  return definePlugin({
    async setup(ctx) {
      ctx.events.on("agent.run.finished", safe(ctx, "run outcome", (e) => onRunFinished(ctx, e)));
      ctx.events.on("issue.comment.created", safe(ctx, "comment", (e) => onCommentCreated(ctx, e)));

      const manifestTool = (name) => ctx.manifest?.tools?.find((t) => t.name === name) ?? { displayName: name, description: name, parametersSchema: { type: "object" } };
      const decl = (name) => {
        const t = manifestTool(name);
        return { displayName: t.displayName, description: t.description, parametersSchema: t.parametersSchema };
      };
      ctx.tools.register("memory_recall", decl("memory_recall"), async (params, runCtx) => {
        try {
          return await memoryRecall(ctx, params, runCtx);
        } catch (err) {
          ctx.logger.warn(`memory_recall failed open: ${err.message}`);
          return { content: "No relevant memories found (memory service unavailable).", data: { memories: [] } };
        }
      });
      ctx.tools.register("memory_retain", decl("memory_retain"), async (params, runCtx) => {
        try {
          return await memoryRetain(ctx, params, runCtx);
        } catch (err) {
          ctx.logger.warn(`memory_retain failed: ${err.message}`);
          return { content: "Memory service unavailable; the memory was not stored.", data: { status: "failed" } };
        }
      });
    },

    async onHealth() {
      return { status: "ok" };
    },
  });
}
