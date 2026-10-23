// Quota-windows store: one cache per browser (see ./shared-store.ts). Since
// v0.3 it serves Codex, and Claude only when the run logs have no data.
// Decisions are in ../cache.ts.

import {
  applyFailure,
  applyResponse,
  markInFlight,
  parseCache,
  shouldFetch,
  type FetchDecision,
  type QuotaCache,
} from "../cache.ts";
import type { ProviderQuotaResult } from "../mapping.ts";
import { createSharedStore } from "./shared-store.ts";

const store = createSharedStore<QuotaCache>("lab.usage-limits.quota.v1", "lab.usage-limits.fetch", parseCache);

export const getSnapshot = store.getSnapshot;
export const isBusy = store.isBusy;
export const subscribe = store.subscribe;

async function fetchQuotaWindows(companyId: string): Promise<ProviderQuotaResult[]> {
  const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/costs/quota-windows`, {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    let reason = `${res.status} ${res.statusText}`.trim();
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") reason = `${reason}: ${body.error}`;
    } catch {
      // keep the status line
    }
    throw new Error(`Quota request failed (${reason})`);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("Quota response was not a list");
  return body as ProviderQuotaResult[];
}

async function fetchIfDue(companyId: string, neededSlugs: string[], manual: boolean): Promise<FetchDecision> {
  const decision = shouldFetch(store.getSnapshot(), Date.now(), { manual });
  if (!decision.fetch) return decision;
  store.write(markInFlight(store.getSnapshot(), Date.now()));
  store.setBusy(true);
  try {
    const results = await fetchQuotaWindows(companyId);
    store.write(applyResponse(store.getSnapshot(), results, Date.now(), neededSlugs));
  } catch (err) {
    store.write(applyFailure(store.getSnapshot(), err instanceof Error ? err.message : String(err), Date.now()));
  } finally {
    store.setBusy(false);
  }
  return decision;
}

/**
 * Fetch quota windows if the shared cache says one is due. Safe to call often
 * and from every tab: at most one fetch runs, and only when due. Only
 * `neededSlugs` count as failures for the backoff.
 */
export async function refresh(companyId: string, neededSlugs: string[], manual: boolean): Promise<FetchDecision> {
  const result = await store.withLock(() => fetchIfDue(companyId, neededSlugs, manual));
  return result ?? { fetch: false, reason: "in-flight", waitMs: 0 };
}
