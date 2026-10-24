// Capture pipeline for one item (a comment, or a run's result comment):
// Jev decides whether it holds anything worth keeping, the extractor writes
// it as a few short memories, and only those are stored. In shadow mode the
// verdicts and memories are logged and nothing is stored.
//
// Items hold IDs only. When Jev or the extractor is down, the item waits in
// plugin state and the retry job tries again, for up to 24 h. Tasks never wait.

import { decideGate } from "./jev.js";
import { hasProse, itemText, sourceLabel } from "./item.js";
import { UNSCOPED_PROJECT, scopeFor } from "./scope.js";

export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const PENDING_MAX_ITEMS = 1000;
export const SHADOW_LOG_MAX_PER_DAY = 2000;
const RETRY_BASE_MS = 10 * 60 * 1000;
const RETRY_MAX_MS = 2 * 60 * 60 * 1000;
const HOST_CALL_TIMEOUT_MS = 5000;

const ITEMS_NS = "memos-items";
const PENDING_KEY = { scopeKind: "instance", namespace: "memos-pending", stateKey: "queue" };
const shadowKey = (companyId, day) => ({ scopeKind: "company", scopeId: companyId, namespace: "memos-shadow", stateKey: day });
const itemKey = (companyId, key) => ({ scopeKind: "company", scopeId: companyId, namespace: ITEMS_NS, stateKey: key });

export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Serializes read-modify-write on one state key inside this worker. */
function createLocks() {
  const tails = new Map();
  return async function withLock(name, fn) {
    const prev = tails.get(name) ?? Promise.resolve();
    let release;
    const next = new Promise((r) => (release = r));
    const tail = prev.then(() => next);
    tails.set(name, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(name) === tail) tails.delete(name);
    }
  };
}

export function retryDelayMs(attempts) {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

export function createCapture({ now = () => Date.now() } = {}) {
  const withLock = createLocks();
  const inflight = new Map();

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

  // ---- pending queue (instance scope, IDs only) ----

  async function enqueue(ctx, item, reason) {
    await withLock("pending", async () => {
      const queue = (await ctx.state.get(PENDING_KEY)) ?? [];
      const t = now();
      const existing = queue.find((q) => q.companyId === item.companyId && q.key === item.key);
      if (existing) {
        existing.attempts = (existing.attempts ?? 0) + 1;
        existing.nextAt = t + retryDelayMs(existing.attempts);
        existing.lastError = reason;
      } else {
        queue.push({ ...item, firstSeenAt: item.firstSeenAt ?? t, attempts: 1, nextAt: t + retryDelayMs(1), lastError: reason });
      }
      while (queue.length > PENDING_MAX_ITEMS) {
        const dropped = queue.shift();
        ctx.logger.warn("memory capture queue full; dropped the oldest item", { key: dropped.key, companyId: dropped.companyId });
      }
      await ctx.state.set(PENDING_KEY, queue);
    });
  }

  async function removePending(ctx, item) {
    await withLock("pending", async () => {
      const queue = (await ctx.state.get(PENDING_KEY)) ?? [];
      const rest = queue.filter((q) => !(q.companyId === item.companyId && q.key === item.key));
      if (rest.length !== queue.length) await ctx.state.set(PENDING_KEY, rest);
    });
  }

  // ---- shadow log (company scope, one key per UTC day) ----

  async function logVerdict(ctx, cfg, item, record) {
    const entry = { at: new Date(now()).toISOString(), mode: cfg.captureMode, key: item.key, source: item.source, ...record };
    ctx.logger.info("memory capture verdict", entry);
    if (cfg.captureMode !== "shadow") return;
    const day = entry.at.slice(0, 10);
    try {
      await withLock(`shadow:${item.companyId}:${day}`, async () => {
        const key = shadowKey(item.companyId, day);
        const log = (await ctx.state.get(key)) ?? [];
        if (log.length >= SHADOW_LOG_MAX_PER_DAY) return;
        log.push(entry);
        await ctx.state.set(key, log);
      });
    } catch (err) {
      ctx.logger.warn(`shadow log entry not saved: ${err.message}`, { key: item.key });
    }
  }

  async function readShadowLog(ctx, companyId, day) {
    return (await ctx.state.get(shadowKey(companyId, day))) ?? [];
  }

  async function markDone(ctx, item, verdict) {
    try {
      await ctx.state.set(itemKey(item.companyId, item.key), { verdict, at: new Date(now()).toISOString() });
    } catch (err) {
      ctx.logger.warn(`item marker not saved; a redelivered event may process it again: ${err.message}`, { key: item.key });
    }
  }

  /**
   * Process one item. `retain(scope, content, metadata)` stores a memory and
   * returns { status }. Returns a status string:
   * duplicate | ignored | no-text | skipped | empty | error | shadow | stored | queued.
   */
  async function processItem(ctx, cfg, item, { retain, deadline }) {
    const lockKey = `${item.companyId}:${item.key}`;
    const running = inflight.get(lockKey);
    if (running) {
      await running.catch(() => {});
      return "duplicate";
    }
    const work = run(ctx, cfg, item, { retain, deadline });
    inflight.set(lockKey, work);
    try {
      return await work;
    } finally {
      inflight.delete(lockKey);
    }
  }

  async function run(ctx, cfg, item, { retain, deadline }) {
    const { companyId } = item;
    if (await ctx.state.get(itemKey(companyId, item.key))) return "duplicate";
    let issue;
    let comment;
    try {
      issue = await loadIssue(ctx, item.issueId, companyId);
      if (!issue || !cfg.captureAllowed(issue.projectId)) return "ignored";
      comment = (await loadComments(ctx, item.issueId, companyId)).find((c) => c.id === item.commentId);
    } catch (err) {
      return queue(ctx, item, `host: ${err.message}`);
    }
    if (!comment || (comment.authorType !== "agent" && comment.authorType !== "user")) return "ignored";

    // The scope a save writes to; shadow entries carry its projectId too.
    const scope = scopeFor({ companyId, projectId: issue.projectId ?? UNSCOPED_PROJECT });
    const ids = {
      projectId: scope.projectId,
      issueId: issue.id,
      issueIdentifier: issue.identifier ?? null,
      commentId: comment.id,
      runId: comment.createdByRunId ?? comment.derivedCreatedByRunId ?? item.runId ?? null,
      agentId: comment.authorAgentId ?? null,
      userId: comment.authorUserId ?? null,
      authorType: comment.authorType,
    };
    const text = itemText(comment.body);
    if (!hasProse(text)) {
      await logVerdict(ctx, cfg, item, { ...ids, verdict: "no-text" });
      await markDone(ctx, item, "no-text");
      return "no-text";
    }
    const source = sourceLabel(comment.authorType, item.source === "run");
    const task = { identifier: issue.identifier ?? null, title: issue.title ?? null };

    let gate;
    let jevCostUsd = null;
    let extracted;
    try {
      const resp = await cfg.jev.ask({ item: { source, text }, task }, { deadline });
      jevCostUsd = resp.costUsd;
      gate = decideGate(resp.answers, { saveP: cfg.saveP, routineP: cfg.routineP });
    } catch (err) {
      return queue(ctx, item, `jev: ${err.message}`);
    }
    if (!gate.pass) {
      await logVerdict(ctx, cfg, item, { ...ids, verdict: "skip", type: gate.type, probs: gate.probs, jevCostUsd });
      await markDone(ctx, item, "skip");
      return "skipped";
    }
    try {
      extracted = await cfg.extractor.extract({ text, task, source, hintType: gate.type }, { deadline });
    } catch (err) {
      if (!err?.badReply) return queue(ctx, item, `extractor: ${err.message}`);
      // A bad answer repeats on every retry: record it once and stop.
      const error = `extractor: ${err.message}`;
      ctx.logger.warn(`memory capture gave up on an item: ${error}`, { key: item.key, companyId });
      await logVerdict(ctx, cfg, item, { ...ids, verdict: "error", error, type: gate.type, probs: gate.probs, jevCostUsd, extractCostUsd: err.costUsd ?? null });
      await markDone(ctx, item, "error");
      return "error";
    }
    const record = { ...ids, type: gate.type, probs: gate.probs, memories: extracted.memories, jevCostUsd, extractCostUsd: extracted.costUsd };
    if (extracted.salvaged) record.salvaged = true;
    if (extracted.memories.length === 0) {
      await logVerdict(ctx, cfg, item, { ...record, verdict: "empty" });
      await markDone(ctx, item, "empty");
      return "empty";
    }
    if (cfg.captureMode === "shadow") {
      await logVerdict(ctx, cfg, item, { ...record, verdict: "pass" });
      await markDone(ctx, item, "shadow");
      return "shadow";
    }

    const results = await Promise.allSettled(
      extracted.memories.map((m) =>
        retain(scope, m.content, {
          ...ids,
          kind: m.type,
          jevType: gate.type,
          jevP: gate.probs[gate.type],
          itemKey: item.key,
          source: item.source === "run" ? "agent.run.finished" : "issue.comment.created",
        }),
      ),
    );
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : "failed"));
    // The first failure's reason, never memory text: an HTTP error, a
    // timeout, or an add MemOS answered with no created memory IDs.
    const failure = results.find((r) => r.status === "rejected" || r.value.status === "failed");
    if (failure) {
      const error = `memos: ${failure.status === "rejected" ? failure.reason?.message : (failure.value.error ?? "add failed")}`;
      await logVerdict(ctx, cfg, item, { ...record, verdict: "pass", stored: statuses, error });
      return queue(ctx, item, error);
    }
    await logVerdict(ctx, cfg, item, { ...record, verdict: "pass", stored: statuses });
    await markDone(ctx, item, "stored");
    return "stored";
  }

  // Every failure with no answer is retried the same way, an outage or a
  // malformed body: both are rare, and the queue is bounded by age. A model
  // answer that is unusable is not queued (see the extractor's catch above).
  async function queue(ctx, item, reason) {
    ctx.logger.warn(`memory capture deferred: ${reason}`, { key: item.key, companyId: item.companyId });
    await enqueue(ctx, item, reason);
    return "queued";
  }

  /**
   * Retry due items, oldest first, until `deadline`. Items older than 24 h
   * are dropped. `configFor(companyId)` returns the capture config.
   */
  async function retryPending(ctx, { configFor, retainFor, deadline, maxItems = 50 }) {
    const queue = (await ctx.state.get(PENDING_KEY)) ?? [];
    const t = now();
    const summary = { dropped: 0, retried: 0, done: 0, requeued: 0 };
    for (const item of queue.filter((q) => t - q.firstSeenAt > PENDING_MAX_AGE_MS)) {
      ctx.logger.warn("memory capture item dropped after 24 h of retries", { key: item.key, companyId: item.companyId, lastError: item.lastError });
      await removePending(ctx, item);
      summary.dropped += 1;
    }
    const due = queue.filter((q) => t - q.firstSeenAt <= PENDING_MAX_AGE_MS && q.nextAt <= t).slice(0, maxItems);
    for (const item of due) {
      if (now() >= deadline) break;
      summary.retried += 1;
      const cfg = await configFor(item.companyId);
      let status;
      try {
        status = await processItem(ctx, cfg, item, { retain: retainFor(cfg), deadline });
      } catch (err) {
        ctx.logger.warn(`memory capture retry failed: ${err.message}`, { key: item.key });
        status = "queued";
        await enqueue(ctx, item, err.message);
      }
      if (status === "queued") summary.requeued += 1;
      else {
        summary.done += 1;
        await removePending(ctx, item);
      }
    }
    return summary;
  }

  return { processItem, retryPending, readShadowLog, loadIssue, loadComments, readPending: (ctx) => ctx.state.get(PENDING_KEY).then((q) => q ?? []) };
}
