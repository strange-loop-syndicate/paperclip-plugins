// Plugin behaviour: capture comments (agent and board) and run results
// through the Jev gate and the extractor (src/capture.js), dedup by
// normalized-content hash per scope, the memory_recall / memory_retain tools,
// the sharing settings page, and the API routes the wrapper reads.
// Nothing here can fail or delay a run: event delivery is fire-and-forget on
// the host, and every handler swallows its own errors.

import { definePlugin } from "@paperclipai/plugin-sdk";
import { createCapture, withTimeout } from "./capture.js";
import { contentHash, normalizeContent } from "./content.js";
import { createExtractor, EXTRACT_MODEL, EXTRACT_TIMEOUT_MS } from "./extractor.js";
import { formatMemoryLine } from "./format.js";
import { commentItemKey } from "./item.js";
import { createJevClient, DEFAULT_ROUTINE_P, DEFAULT_SAVE_P, JEV_MODEL, JEV_TIMEOUT_MS } from "./jev.js";
import { createMemosClient, recallAcrossScopes, DEFAULT_CAPTURE_TIMEOUT_MS, DEFAULT_RECALL_TIMEOUT_MS, DEFAULT_TOP_K } from "./memos-client.js";
import { normalizeShares, readableShares, recallScopes, scopeFor, UNSCOPED_PROJECT } from "./scope.js";

const DEDUP_NAMESPACE = "memos-dedup";
const SHARING_KEY = (companyId) => ({ scopeKind: "company", scopeId: companyId, namespace: "memos-settings", stateKey: "sharing" });
const HOST_CALL_TIMEOUT_MS = 5000;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// The host's onEvent RPC gives up after 30 s; inline capture stops before
// that and leaves the rest to the retry job.
export const EVENT_BUDGET_MS = 25000;
const RETRY_JOB_BUDGET_MS = 4 * 60 * 1000;
export const RETRY_JOB_KEY = "retry-pending-captures";

function num(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function prob(value, fallback) {
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

// MemOS is called with the worker's own fetch, not ctx.http.fetch: the host
// fetch refuses loopback/private addresses (where self-hosted MemOS lives) and
// drops the abort signal, so timeouts would not hold. The URL is operator
// config, not agent input. OpenRouter calls use the same fetch.
export function createMemoryPlugin({ fetchImpl = (url, init) => globalThis.fetch(url, init), now = () => Date.now(), sleep } = {}) {
  // Concurrent redelivery inside this worker process shares one in-flight
  // write; ctx.state guards redelivery across time and restarts.
  const inflight = new Map();
  const capture = createCapture({ now });
  // onApiRequest gets no ctx of its own; setup stores it here.
  let hostCtx = null;

  async function resolveSecret(ctx, ref, label) {
    if (typeof ref !== "string" || ref.trim() === "") return null;
    try {
      return await ctx.secrets.resolve(ref);
    } catch (err) {
      ctx.logger.warn(`${label} secret could not be resolved`, { error: err.message });
      return null;
    }
  }

  async function loadConfig(ctx, companyId) {
    const raw = (await ctx.config.get(companyId)) ?? {};
    const memosApiKey = await resolveSecret(ctx, raw.memosApiKeyRef, "memos api key");
    const openrouterKey = await resolveSecret(ctx, raw.openrouterApiKeyRef, "openrouter api key");
    const base = (typeof raw.openrouterBaseUrl === "string" && raw.openrouterBaseUrl.trim() ? raw.openrouterBaseUrl : OPENROUTER_BASE_URL).replace(/\/+$/, "");
    const captureProjectIds = Array.isArray(raw.captureProjectIds) ? raw.captureProjectIds.filter((p) => typeof p === "string" && p !== "") : [];
    return {
      companyId,
      client: createMemosClient({ baseUrl: raw.memosBaseUrl, apiKey: memosApiKey, fetchImpl, logger: ctx.logger }),
      recallTimeoutMs: num(raw.recallTimeoutMs, DEFAULT_RECALL_TIMEOUT_MS),
      captureTimeoutMs: num(raw.captureTimeoutMs, DEFAULT_CAPTURE_TIMEOUT_MS),
      topK: num(raw.topK, DEFAULT_TOP_K),
      captureComments: raw.captureComments !== false,
      captureRunOutcomes: raw.captureRunOutcomes !== false,
      // Saving is off until an operator sets "save": shadow logs only.
      captureMode: raw.captureMode === "save" ? "save" : "shadow",
      saveP: prob(raw.saveP, DEFAULT_SAVE_P),
      routineP: prob(raw.routineP, DEFAULT_ROUTINE_P),
      llmConfigured: Boolean(openrouterKey),
      jev: createJevClient({ apiKey: openrouterKey, fetchImpl, sleep, now, model: raw.jevModel || JEV_MODEL, url: `${base}/systemone`, timeoutMs: num(raw.jevTimeoutMs, JEV_TIMEOUT_MS) }),
      extractor: createExtractor({ apiKey: openrouterKey, fetchImpl, sleep, now, model: raw.extractModel || EXTRACT_MODEL, url: `${base}/chat/completions`, timeoutMs: num(raw.extractTimeoutMs, EXTRACT_TIMEOUT_MS) }),
      // An empty `captureProjectIds` captures every project; a list captures only those.
      captureAllowed: (projectId) => captureProjectIds.length === 0 || captureProjectIds.includes(projectId ?? UNSCOPED_PROJECT),
    };
  }

  /**
   * Store one memory unless the same normalized content was already stored in
   * this scope. Returns { status: "stored" | "duplicate" | "failed", contentHash }.
   */
  async function retain(ctx, cfg, { scope, content, metadata }) {
    const hash = contentHash(content);
    const stateKey = { scopeKind: "company", scopeId: scope.companyId, namespace: DEDUP_NAMESPACE, stateKey: `${scope.projectId}:${hash}` };
    const lockKey = `${scope.key}:${hash}`;
    const pending = inflight.get(lockKey);
    if (pending) {
      // Report what the concurrent write actually did, not a guess.
      const first = await pending;
      return { status: first.status === "failed" ? "failed" : "duplicate", contentHash: hash };
    }
    const work = (async () => {
      if (await ctx.state.get(stateKey)) return { status: "duplicate", contentHash: hash };
      const fullMetadata = { ...metadata, companyId: scope.companyId, projectId: scope.projectId, contentHash: hash };
      const res = await cfg.client.add({ scope, content, metadata: fullMetadata, timeoutMs: cfg.captureTimeoutMs });
      if (!res.ok) return { status: "failed", contentHash: hash };
      // The memory is already in MemOS, so report it stored. Without the
      // marker a redelivered event can store it again (see SETUP.md, limits).
      try {
        await ctx.state.set(stateKey, { storedAt: new Date(now()).toISOString(), kind: metadata.kind ?? null, runId: metadata.runId ?? null });
      } catch (err) {
        ctx.logger.warn(`dedup marker not saved; a redelivered event may store this memory again: ${err.message}`, { contentHash: hash });
      }
      return { status: "stored", contentHash: hash };
    })();
    inflight.set(lockKey, work);
    try {
      return await work;
    } finally {
      inflight.delete(lockKey);
    }
  }

  const retainFor = (ctx) => (cfg) => (scope, content, metadata) => retain(ctx, cfg, { scope, content, metadata });

  function safe(ctx, label, fn) {
    return async (event) => {
      try {
        await fn(event);
      } catch (err) {
        ctx.logger.warn(`${label} capture skipped: ${err.message}`, { eventId: event?.eventId });
      }
    };
  }

  function captureReady(cfg) {
    return cfg.client.configured && cfg.llmConfigured;
  }

  async function capture1(ctx, cfg, item) {
    return capture.processItem(ctx, cfg, { ...item, firstSeenAt: now() }, { retain: retainFor(ctx)(cfg), deadline: now() + EVENT_BUDGET_MS });
  }

  async function onCommentCreated(ctx, event) {
    const { companyId } = event;
    const payload = event.payload ?? {};
    // Agent and board comments; system and plugin comments are not memories.
    if (event.actorType !== "agent" && event.actorType !== "user") return;
    const issueId = event.entityId;
    const commentId = payload.commentId;
    if (!issueId || !commentId) return;
    const cfg = await loadConfig(ctx, companyId);
    if (!cfg.captureComments || !captureReady(cfg)) return;
    await capture1(ctx, cfg, { key: commentItemKey(commentId), companyId, issueId, commentId, runId: payload.runId ?? null, source: "comment" });
  }

  // The run result is the run's newest agent comment. It shares the comment's
  // item key, so a comment seen through both events is processed once.
  async function onRunFinished(ctx, event) {
    const { companyId } = event;
    const { runId, issueId } = event.payload ?? {};
    if (!runId || !issueId) return;
    const cfg = await loadConfig(ctx, companyId);
    if (!cfg.captureRunOutcomes || !captureReady(cfg)) return;
    const comments = await capture.loadComments(ctx, issueId, companyId);
    // The host lists comments newest first; sort explicitly rather than rely on it.
    const last = comments
      .filter((c) => (c.createdByRunId ?? c.derivedCreatedByRunId) === runId && c.authorType === "agent")
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt) || String(b.id).localeCompare(String(a.id)))[0];
    if (!last) return;
    await capture1(ctx, cfg, { key: commentItemKey(last.id), companyId, issueId, commentId: last.id, runId, source: "run" });
  }

  // ---- sharing (settings page is the only writer) ----

  /** This company's projects, archived ones included. */
  async function listCompanyProjects(ctx, companyId) {
    const projects = await withTimeout(ctx.projects.list({ companyId, limit: 500 }), HOST_CALL_TIMEOUT_MS, "projects.list");
    return (projects ?? []).filter((p) => p.companyId === companyId);
  }

  async function listProjects(ctx, companyId) {
    return (await listCompanyProjects(ctx, companyId)).filter((p) => !p.archivedAt);
  }

  async function loadShares(ctx, companyId) {
    const stored = await ctx.state.get(SHARING_KEY(companyId));
    return normalizeShares(stored, { onInvalid: (msg) => ctx.logger.warn(`ignoring stored sharing entry: ${msg}`) });
  }

  /** Shared scopes this reader may read. Fails closed: on error, own scope only. */
  async function sharedFor(ctx, companyId, projectId) {
    try {
      return readableShares({ projectId, shares: await loadShares(ctx, companyId) });
    } catch (err) {
      ctx.logger.warn(`sharing settings unreadable; recalling own project only: ${err.message}`);
      return [];
    }
  }

  async function sharingSettings(ctx, params) {
    const companyId = params.companyId;
    if (typeof companyId !== "string" || !companyId) throw new Error("companyId is required");
    const projects = await listProjects(ctx, companyId);
    return { projects: projects.map((p) => ({ id: p.id, name: p.name })), shares: await loadShares(ctx, companyId) };
  }

  async function saveSharing(ctx, params, actionCtx) {
    // Only a board user may change who reads what; agents can reach plugin
    // actions through the API too.
    if (actionCtx?.actor?.type !== "user") throw new Error("Only a board user can change memory sharing.");
    const companyId = actionCtx.companyId ?? params.companyId;
    if (typeof companyId !== "string" || !companyId) throw new Error("companyId is required");
    const all = await listCompanyProjects(ctx, companyId);
    const known = new Map(all.filter((p) => !p.archivedAt).map((p) => [p.id, p.name]));
    // Projects that were this company's but are gone from the page: archived
    // ones, and any the stored settings name (checked when they were saved).
    // Their shares are dropped, not refused, or the page could never save again.
    // Readers outside `known` are dropped by normalizeShares already.
    const retired = new Set(all.filter((p) => p.archivedAt).map((p) => p.id));
    for (const s of await loadShares(ctx, companyId)) retired.add(s.projectId);
    for (const id of known.keys()) retired.delete(id);
    const submitted = Array.isArray(params.shares) ? params.shares : Array.isArray(params.shares?.shares) ? params.shares.shares : [];
    const dropped = submitted.filter((s) => retired.has(s?.projectId)).map((s) => s.projectId);
    if (dropped.length) ctx.logger.info("memory sharing: dropping shares of archived projects", { companyId, projectIds: dropped });
    const kept = submitted.filter((s) => !retired.has(s?.projectId));
    const problems = [];
    const shares = normalizeShares(kept, { knownProjects: known, onInvalid: (m) => problems.push(m) });
    if (problems.length) throw new Error(`Sharing not saved: ${problems.join("; ")}`);
    await ctx.state.set(SHARING_KEY(companyId), { shares, updatedAt: new Date(now()).toISOString(), updatedBy: actionCtx.actor.userId ?? null });
    ctx.logger.info("memory sharing updated", { companyId, shares: shares.map((s) => ({ projectId: s.projectId, readers: s.readers })) });
    return { shares };
  }

  // ---- tools ----

  async function memoryRecall(ctx, params, runCtx) {
    const query = typeof params?.query === "string" ? params.query.trim() : "";
    if (!query) return { error: "query is required" };
    const cfg = await loadConfig(ctx, runCtx.companyId);
    const limit = Math.min(num(params.limit, cfg.topK), 20);
    const shared = await sharedFor(ctx, runCtx.companyId, runCtx.projectId);
    const scopes = recallScopes({ companyId: runCtx.companyId, projectId: runCtx.projectId, shared });
    const memories = await recallAcrossScopes({ client: cfg.client, scopes, query, topK: limit, timeoutMs: cfg.recallTimeoutMs, normalize: normalizeContent });
    if (memories.length === 0) return { content: "No relevant memories found.", data: { memories: [] } };
    return {
      content: memories.map(formatMemoryLine).join("\n"),
      data: {
        memories: memories.map((m) => ({
          content: m.content,
          scope: m.scopeKey,
          kind: m.metadata.kind ?? null,
          issueIdentifier: m.metadata.issueIdentifier ?? null,
          sharedFrom: m.sharedFrom ?? null,
        })),
      },
    };
  }

  async function memoryRetain(ctx, params, runCtx) {
    const content = typeof params?.content === "string" ? params.content.trim() : "";
    if (content.length < 3) return { error: "content is required" };
    const kind = ["decision", "lesson", "outcome", "fact", "note"].includes(params.kind) ? params.kind : "note";
    const cfg = await loadConfig(ctx, runCtx.companyId);
    let issue = null;
    if (typeof params.issueId === "string" && params.issueId) {
      issue = await capture.loadIssue(ctx, params.issueId, runCtx.companyId).catch(() => null);
    }
    // Writes never move: the memory goes to the run's own project. An issue
    // from another project is refused, so naming one cannot write there.
    const scope = scopeFor({ companyId: runCtx.companyId, projectId: runCtx.projectId });
    if (issue && scopeFor({ companyId: runCtx.companyId, projectId: issue.projectId }).key !== scope.key) {
      return { error: "That issue belongs to another project; the memory was not stored.", data: { status: "rejected" } };
    }
    if (!cfg.captureAllowed(runCtx.projectId)) {
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

  // ---- API routes ----

  async function onApiRequest(ctx, input) {
    if (input.routeKey === "recall-scopes") {
      // The wrapper asks which shared projects a reader project may read.
      const projectId = typeof input.query?.projectId === "string" ? input.query.projectId : null;
      return { status: 200, body: { scopes: await sharedFor(ctx, input.companyId, projectId) } };
    }
    if (input.routeKey === "shadow-log") {
      const day = typeof input.query?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.query.date) ? input.query.date : new Date(now()).toISOString().slice(0, 10);
      const entries = await capture.readShadowLog(ctx, input.companyId, day);
      const pending = (await capture.readPending(ctx)).filter((q) => q.companyId === input.companyId);
      return { status: 200, body: { date: day, entries, pending } };
    }
    return { status: 404, body: { error: "unknown route" } };
  }

  return definePlugin({
    async setup(ctx) {
      ctx.events.on("agent.run.finished", safe(ctx, "run result", (e) => onRunFinished(ctx, e)));
      ctx.events.on("issue.comment.created", safe(ctx, "comment", (e) => onCommentCreated(ctx, e)));

      ctx.jobs.register(RETRY_JOB_KEY, async () => {
        const configs = new Map();
        const configFor = async (companyId) => {
          if (!configs.has(companyId)) configs.set(companyId, await loadConfig(ctx, companyId));
          return configs.get(companyId);
        };
        const summary = await capture.retryPending(ctx, { configFor, retainFor: retainFor(ctx), deadline: now() + RETRY_JOB_BUDGET_MS });
        if (summary.retried || summary.dropped) ctx.logger.info("memory capture retry job", summary);
      });

      ctx.data.register("sharing-settings", (params) => sharingSettings(ctx, params));
      ctx.actions.register("save-sharing", (params, actionCtx) => saveSharing(ctx, params, actionCtx));

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
      hostCtx = ctx;
    },

    async onApiRequest(input) {
      try {
        return await onApiRequest(hostCtx, input);
      } catch (err) {
        hostCtx?.logger.warn(`api route ${input.routeKey} failed: ${err.message}`);
        return { status: 503, body: { error: "memory plugin unavailable" } };
      }
    },

    async onHealth() {
      return { status: "ok" };
    },
  });
}
