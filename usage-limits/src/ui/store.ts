// One quota store per browser: the cache lives in localStorage, every tab
// reads it, and a Web Lock (or the cache's in-flight marker where Web Locks
// are missing) lets only one tab fetch at a time. Decisions are in ../cache.ts.

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

const STORAGE_KEY = "lab.usage-limits.quota.v1";
const LOCK_NAME = "lab.usage-limits.fetch";

let memoryRaw: string | null = null;
let snapshotRaw: string | null | undefined;
let snapshot: QuotaCache | null = null;
let busy = false;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return memoryRaw;
  }
}

function write(cache: QuotaCache): void {
  const raw = JSON.stringify(cache);
  memoryRaw = raw;
  try {
    window.localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // storage full or blocked: this tab keeps the in-memory copy
  }
  notify();
}

function notify(): void {
  for (const fn of listeners) fn();
}

/** Current cache; the same object until the stored value changes. */
export function getSnapshot(): QuotaCache | null {
  const raw = readRaw();
  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
    snapshot = parseCache(raw);
  }
  return snapshot;
}

export function isBusy(): boolean {
  return busy;
}

/** Subscribe to changes from this tab and, through the `storage` event, from others. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

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

async function fetchIfDue(companyId: string, usedSlugs: string[], manual: boolean): Promise<FetchDecision> {
  const decision = shouldFetch(getSnapshot(), Date.now(), { manual });
  if (!decision.fetch) return decision;
  write(markInFlight(getSnapshot(), Date.now()));
  busy = true;
  notify();
  try {
    const results = await fetchQuotaWindows(companyId);
    write(applyResponse(getSnapshot(), results, Date.now(), usedSlugs));
  } catch (err) {
    write(applyFailure(getSnapshot(), err instanceof Error ? err.message : String(err), Date.now()));
  } finally {
    busy = false;
    notify();
  }
  return decision;
}

/**
 * Fetch quota windows if the shared cache says one is due. Safe to call often
 * and from every tab: at most one fetch runs, and only when due.
 */
export async function refresh(companyId: string, usedSlugs: string[], manual: boolean): Promise<FetchDecision> {
  if (busy) return { fetch: false, reason: "in-flight", waitMs: 0 };
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return fetchIfDue(companyId, usedSlugs, manual);
  const result = await locks.request(LOCK_NAME, { ifAvailable: true }, (lock) =>
    lock ? fetchIfDue(companyId, usedSlugs, manual) : null,
  );
  return result ?? { fetch: false, reason: "in-flight", waitMs: 0 };
}
