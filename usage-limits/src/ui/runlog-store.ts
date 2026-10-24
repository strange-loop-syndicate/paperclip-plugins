// Run-log store: the newest Claude `rate_limit_event`, read through the
// board's own run routes and shared by every tab (see ./shared-store.ts).
// Parsing and decisions are in ../runlog.ts.

import {
  applyScan,
  applyScanFailure,
  markScanStarted,
  parseRunLogCache,
  RUN_LIST_LIMIT,
  scanDue,
  scanRuns,
  type RunLogCache,
  type RunSummary,
} from "../runlog.ts";
import { createSharedStore } from "./shared-store.ts";

const store = createSharedStore<RunLogCache>("lab.usage-limits.runlog.v1", "lab.usage-limits.runlog", parseRunLogCache);

export const getRunLogSnapshot = store.getSnapshot;
export const subscribeRunLog = store.subscribe;

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
  return { status: res.status, body: await res.json() };
}

async function listRuns(companyId: string): Promise<RunSummary[]> {
  const { body } = await getJson(
    `/api/companies/${encodeURIComponent(companyId)}/heartbeat-runs?limit=${RUN_LIST_LIMIT}&summary=true`,
  );
  if (!Array.isArray(body)) throw new Error("Run list was not a list");
  return body as RunSummary[];
}

async function readLog(runId: string, offset: number, limitBytes: number): Promise<string | null> {
  const { body } = await getJson(
    `/api/heartbeat-runs/${encodeURIComponent(runId)}/log?offset=${Math.max(0, Math.floor(offset))}&limitBytes=${Math.max(1, Math.floor(limitBytes))}`,
  );
  const content = body && typeof body === "object" ? (body as { content?: unknown }).content : null;
  return typeof content === "string" ? content : null;
}

async function scanIfDue(companyId: string, agentIds: string[]): Promise<void> {
  if (!scanDue(store.getSnapshot(), companyId, Date.now())) return;
  store.write(markScanStarted(store.getSnapshot(), companyId, Date.now()));
  store.setBusy(true);
  try {
    const runs = await listRuns(companyId);
    const scan = await scanRuns(runs, agentIds, readLog);
    store.write(applyScan(store.getSnapshot(), companyId, scan, Date.now()));
  } catch (err) {
    const message = `Run list request failed (${err instanceof Error ? err.message : String(err)})`;
    store.write(applyScanFailure(store.getSnapshot(), companyId, message, Date.now()));
  } finally {
    store.setBusy(false);
  }
}

/** Scan the Claude agents' recent run logs if due. Safe to call often and from every tab. */
export async function refreshRunLog(companyId: string, agentIds: string[]): Promise<void> {
  if (agentIds.length === 0) return;
  await store.withLock(() => scanIfDue(companyId, agentIds));
}
