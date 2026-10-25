// Event health: notice when the host stops delivering events to this worker.
// A hot reload can restart the worker without re-subscribing it (SLS-60). The
// plugin then stays `ready`, logs nothing and captures nothing, while its jobs
// keep running. So every event leaves a per-company mark, and a job compares
// that mark with the newest comment in the company. Comments that came in
// while no event arrived for DEAF_AFTER_MS mean the plugin is deaf: it logs an
// error and posts one comment on the alert issue. Only the board can repair it
// (disable, then enable the plugin), so the plugin never tries to.

import { withTimeout } from "./capture.js";

export const HEALTH_JOB_KEY = "event-health";
export const DEAF_AFTER_MS = 10 * 60 * 1000;
// A comment counts once it is this old: its event may still be on its way.
export const COMMENT_GRACE_MS = 2 * 60 * 1000;
// A busy worker rewrites its mark at most this often. So an event can be up to
// this much newer than the stored mark, and so can the comment it carried.
export const MARK_EVERY_MS = 60 * 1000;
// Issues whose comments one check reads, newest activity first.
export const MAX_ISSUES_SCANNED = 25;
export const DEFAULT_ALERT_ISSUE = "SLS-120";
const HOST_CALL_TIMEOUT_MS = 5000;
const LIST_TIMEOUT_MS = 15000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Host comment paths that write an agent comment but send no
// `issue.comment.created`: workspace-ready and continuation-exhausted notes
// (no reason given), the onboarding greeting, and chat run summaries.
const UNANNOUNCED_REASONS = new Set(["internal_agent_write", "onboarding first-task greeting", "allow_chat_run_presentation"]);
const announced = (c) => c.presentation == null && !UNANNOUNCED_REASONS.has(c.metadata?.authorizationReason);

// One instance key holds every company's mark, so a fresh worker knows which
// companies to check before it has seen a single event.
const MARKS_KEY = { scopeKind: "instance", namespace: "memos-health", stateKey: "last-event" };
const alertKey = (companyId) => ({ scopeKind: "company", scopeId: companyId, namespace: "memos-health", stateKey: "alert" });

const ms = (value) => {
  const t = value == null ? NaN : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
};
const iso = (t) => new Date(t).toISOString();

export function createEventHealth({ now = () => Date.now() } = {}) {
  // companyId -> when this worker last wrote the mark
  const written = new Map();
  let markLock = Promise.resolve();

  /** Record that an event for this company reached the worker. Never throws. */
  async function markEvent(ctx, companyId) {
    if (typeof companyId !== "string" || !companyId) return;
    const t = now();
    const last = written.get(companyId);
    if (last !== undefined && t - last < MARK_EVERY_MS) return;
    written.set(companyId, t);
    const run = markLock.then(async () => {
      const marks = (await ctx.state.get(MARKS_KEY)) ?? {};
      if ((ms(marks[companyId]) ?? 0) >= t) return;
      marks[companyId] = iso(t);
      await ctx.state.set(MARKS_KEY, marks);
    });
    markLock = run.catch(() => {});
    try {
      await run;
    } catch (err) {
      written.delete(companyId);
      ctx.logger.warn(`event health mark not saved: ${err.message}`, { companyId });
    }
  }

  /**
   * The newest agent or board comment created from `from` up to `until`, or
   * null. Only issues with activity from `from` on can hold one.
   */
  async function newestCommentBetween(ctx, companyId, issues, from, until) {
    const candidates = issues
      .map((issue) => ({ issue, at: ms(issue.lastActivityAt) ?? ms(issue.updatedAt) }))
      .filter((c) => c.at !== null && c.at >= from)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_ISSUES_SCANNED);
    let newest = null;
    for (const { issue } of candidates) {
      const comments = await withTimeout(ctx.issues.listComments(issue.id, companyId), HOST_CALL_TIMEOUT_MS, "issues.listComments");
      for (const c of comments ?? []) {
        if (c.companyId !== companyId || c.deletedAt) continue;
        // System and plugin comments may reach plugins by other paths, or not at all.
        if (c.authorType !== "agent" && c.authorType !== "user") continue;
        if (!announced(c)) continue;
        const at = ms(c.createdAt);
        if (at === null || at < from || at > until) continue;
        if (!newest || at > newest.at) newest = { at, issueIdentifier: issue.identifier ?? issue.id };
      }
    }
    return newest;
  }

  function findAlertIssue(issues, ref) {
    return issues.find((i) => i.id === ref || i.identifier === ref) ?? null;
  }

  function alertBody({ since, comment }) {
    return [
      "## ⛔ MemOS Memory plugin stopped getting events",
      "",
      `- **No event since:** ${iso(since)}`,
      `- **Comments since then:** the newest is ${iso(comment.at)} on ${comment.issueIdentifier}`,
      "- **Effect:** new comments and finished runs are not captured. The plugin still shows `ready` and logs no error.",
      "- **Likely cause:** a hot reload restarted the worker without its event subscriptions (SLS-60).",
      "",
      "## ✅ Board: disable, then enable the plugin",
      "- **Where:** Settings → Plugins → MemOS Memory. Agents cannot do this.",
      "- **After:** the plugin logs a recovery line once events come back. This alert is not repeated during the same outage.",
    ].join("\n");
  }

  /** One check for one company. Returns what it found: ok | quiet | deaf | alerted | recovered | no-mark. */
  async function checkCompany(ctx, companyId, lastEventAt, cfg) {
    const key = alertKey(companyId);
    const alert = await ctx.state.get(key);
    const t = now();

    if (alert && lastEventAt > ms(alert.since)) {
      ctx.logger.info("memory plugin events are back; deaf alert cleared", { companyId, deafSince: alert.since, eventAt: iso(lastEventAt), alertCommentId: alert.commentId ?? null });
      await ctx.state.delete(key);
      return "recovered";
    }
    if (alert?.posted) return "alerted";
    if (!alert && t - lastEventAt < DEAF_AFTER_MS) return "ok";

    const issues = (await withTimeout(ctx.issues.list({ companyId }), LIST_TIMEOUT_MS, "issues.list") ?? []).filter((i) => i.companyId === companyId);
    let current = alert;
    if (!current) {
      // An event that came less than MARK_EVERY_MS after the mark left no
      // newer mark, and its comment is older than the event. So the search
      // starts where such comments end.
      const comment = await newestCommentBetween(ctx, companyId, issues, lastEventAt + MARK_EVERY_MS, t - COMMENT_GRACE_MS);
      if (!comment) return "quiet";
      // Saved before the comment is posted: if saving fails nothing is posted,
      // so a broken state store cannot turn into a comment every minute.
      current = { since: iso(lastEventAt), lastCommentAt: iso(comment.at), lastCommentIssue: comment.issueIdentifier, detectedAt: iso(t), posted: false };
      await ctx.state.set(key, current);
      ctx.logger.error("memory plugin is deaf: comments arrive but no events reach it; a board user must disable and enable the plugin", {
        companyId,
        lastEventAt: current.since,
        lastCommentAt: current.lastCommentAt,
        lastCommentIssue: current.lastCommentIssue,
      });
    }

    const ref = cfg.alertIssue;
    if (!ref) return "deaf";
    const target = findAlertIssue(issues, ref) ?? (UUID.test(ref) ? await withTimeout(ctx.issues.get(ref, companyId), HOST_CALL_TIMEOUT_MS, "issues.get") : null);
    if (!target || target.companyId !== companyId) {
      if (!current.issueMissing) {
        ctx.logger.warn("event health alert issue not found; alert logged only", { companyId, alertIssue: ref });
        await ctx.state.set(key, { ...current, issueMissing: true });
      }
      return "deaf";
    }
    const posted = await withTimeout(
      ctx.issues.createComment(target.id, alertBody({ since: ms(current.since), comment: { at: ms(current.lastCommentAt), issueIdentifier: current.lastCommentIssue } }), companyId),
      HOST_CALL_TIMEOUT_MS,
      "issues.createComment",
    );
    await ctx.state.set(key, { ...current, posted: true, postedAt: iso(now()), alertIssue: target.identifier ?? target.id, commentId: posted?.id ?? null });
    return "alerted";
  }

  /** The job: check every company that has a mark. One company's failure does not stop the others. */
  async function check(ctx, { configFor }) {
    const marks = (await ctx.state.get(MARKS_KEY)) ?? {};
    const results = {};
    for (const [companyId, value] of Object.entries(marks)) {
      const lastEventAt = ms(value);
      if (lastEventAt === null) {
        results[companyId] = "no-mark";
        continue;
      }
      try {
        results[companyId] = await checkCompany(ctx, companyId, lastEventAt, await configFor(companyId));
      } catch (err) {
        results[companyId] = "error";
        ctx.logger.warn(`event health check failed: ${err.message}`, { companyId });
      }
    }
    return results;
  }

  return { markEvent, check };
}

export function alertIssueFrom(raw) {
  if (raw?.eventHealthIssue === undefined || raw?.eventHealthIssue === null) return DEFAULT_ALERT_ISSUE;
  return typeof raw.eventHealthIssue === "string" ? raw.eventHealthIssue.trim() : "";
}
