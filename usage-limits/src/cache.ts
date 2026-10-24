// Shared quota cache: pure decision logic for when to fetch, and how a
// response or a failure updates the cached state. No DOM access, so
// `node --test` can load it directly. The UI keeps one copy in localStorage
// so every open tab reads the same entry and only one of them fetches.

import { pickResult, type LastGood, type ProviderQuotaResult } from "./mapping.ts";

/** Normal refresh interval, shared across all tabs. */
export const BASE_INTERVAL_MS = 5 * 60_000;
/** Longest wait after repeated failures. */
export const MAX_BACKOFF_MS = 30 * 60_000;
/** Minimum gap between two fetches, also for the manual ↻ button. */
export const MANUAL_MIN_GAP_MS = 60_000;
/**
 * How long a started fetch blocks other tabs. Longer than the server's 20 s
 * per-provider timeout, so a slow request is not duplicated, but short enough
 * that a tab closed mid-fetch does not block the others for long.
 */
export const IN_FLIGHT_TTL_MS = 45_000;

export const CACHE_VERSION = 1;

export interface QuotaCache {
  v: typeof CACHE_VERSION;
  /** Start of the latest fetch attempt (ms epoch). */
  lastAttemptAt: number;
  /** A fetch started at `lastAttemptAt` is running until this time (ms epoch); 0 when none. */
  inFlightUntil: number;
  /** When `results` arrived (ms epoch); null before the first response. */
  fetchedAt: number | null;
  /** Latest response; null when the latest fetch failed as a whole. */
  results: ProviderQuotaResult[] | null;
  /** Why the latest fetch failed as a whole; null after a response. */
  fetchError: string | null;
  /** Last good windows per provider slug, kept across failures. */
  lastGood: Record<string, LastGood>;
  /** Consecutive fetches in which a used provider failed. */
  failures: number;
  /** Earliest next automatic fetch (ms epoch). */
  nextAt: number;
}

export type FetchDecision =
  | { fetch: true }
  | { fetch: false; reason: "fresh" | "backoff" | "min-gap" | "in-flight"; waitMs: number };

/** Wait before the next automatic fetch: 5 min, then 10, 20, 30 min after failures. */
export function backoffMs(failures: number): number {
  if (failures <= 0) return BASE_INTERVAL_MS;
  return Math.min(MAX_BACKOFF_MS, BASE_INTERVAL_MS * 2 ** Math.min(failures, 10));
}

export function emptyCache(): QuotaCache {
  return {
    v: CACHE_VERSION,
    lastAttemptAt: 0,
    inFlightUntil: 0,
    fetchedAt: null,
    results: null,
    fetchError: null,
    lastGood: {},
    failures: 0,
    nextAt: 0,
  };
}

/**
 * Should this tab fetch now? Nothing cached → yes. Another tab's fetch is
 * running → no. Any fetch obeys a 60 s gap. Manual skips the backoff;
 * automatic waits for `nextAt` (5 min, longer while backing off).
 * A wait longer than any we would set (clock change, bad data) is ignored,
 * so a broken entry cannot block fetching forever.
 */
export function shouldFetch(cache: QuotaCache | null, now: number, opts: { manual: boolean }): FetchDecision {
  if (!cache) return { fetch: true };
  if (cache.inFlightUntil > now && cache.inFlightUntil - now <= IN_FLIGHT_TTL_MS) {
    return { fetch: false, reason: "in-flight", waitMs: cache.inFlightUntil - now };
  }
  const sinceAttempt = now - cache.lastAttemptAt;
  if (sinceAttempt >= 0 && sinceAttempt < MANUAL_MIN_GAP_MS) {
    return { fetch: false, reason: "min-gap", waitMs: MANUAL_MIN_GAP_MS - sinceAttempt };
  }
  if (opts.manual) return { fetch: true };
  const wait = cache.nextAt - now;
  if (wait > 0 && wait <= MAX_BACKOFF_MS) {
    return { fetch: false, reason: cache.failures > 0 ? "backoff" : "fresh", waitMs: wait };
  }
  return { fetch: true };
}

/** Mark a fetch as started, so other tabs wait for it. */
export function markInFlight(cache: QuotaCache | null, now: number): QuotaCache {
  return { ...(cache ?? emptyCache()), lastAttemptAt: now, inFlightUntil: now + IN_FLIGHT_TTL_MS };
}

/**
 * Store a response. Providers that returned windows replace their last good
 * data. If any provider in `usedSlugs` failed (or is missing), the failure
 * count goes up and the next fetch backs off; otherwise it resets to 5 min.
 */
export function applyResponse(
  cache: QuotaCache | null,
  results: ProviderQuotaResult[],
  now: number,
  usedSlugs: ReadonlyArray<string>,
): QuotaCache {
  const prev = cache ?? emptyCache();
  const lastGood: Record<string, LastGood> = { ...prev.lastGood };
  for (const slug of new Set(results.map((r) => r.provider))) {
    const r = pickResult(results, slug);
    if (r?.ok && Array.isArray(r.windows) && r.windows.length > 0) {
      lastGood[slug] = { windows: r.windows, fetchedAt: now, source: r.source ?? null };
    }
  }
  const anyFailed = usedSlugs.some((slug) => !pickResult(results, slug)?.ok);
  const failures = anyFailed ? prev.failures + 1 : 0;
  return {
    ...prev,
    inFlightUntil: 0,
    fetchedAt: now,
    results,
    fetchError: null,
    lastGood,
    failures,
    nextAt: now + backoffMs(failures),
  };
}

/** Store a failure of the whole request (HTTP error, network). Last good data stays. */
export function applyFailure(cache: QuotaCache | null, message: string, now: number): QuotaCache {
  const prev = cache ?? emptyCache();
  const failures = prev.failures + 1;
  return {
    ...prev,
    inFlightUntil: 0,
    results: null,
    fetchError: message,
    failures,
    nextAt: now + backoffMs(failures),
  };
}

/** When the next automatic attempt is, if we are backing off; else null. */
export function retryAt(cache: QuotaCache | null): number | null {
  return cache && cache.failures > 0 ? cache.nextAt : null;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Parse a stored entry; null for a missing, foreign or malformed value. */
export function parseCache(raw: string | null): QuotaCache | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const c = value as Partial<QuotaCache>;
  if (c.v !== CACHE_VERSION) return null;
  if (!isNum(c.lastAttemptAt) || !isNum(c.inFlightUntil) || !isNum(c.failures) || !isNum(c.nextAt)) return null;
  if (c.fetchedAt !== null && !isNum(c.fetchedAt)) return null;
  if (c.results !== null && !Array.isArray(c.results)) return null;
  if (c.fetchError !== null && typeof c.fetchError !== "string") return null;
  if (!c.lastGood || typeof c.lastGood !== "object" || Array.isArray(c.lastGood)) return null;
  const lastGood: Record<string, LastGood> = {};
  for (const [slug, good] of Object.entries(c.lastGood)) {
    if (good && Array.isArray(good.windows) && isNum(good.fetchedAt)) lastGood[slug] = good;
  }
  return {
    v: CACHE_VERSION,
    lastAttemptAt: c.lastAttemptAt,
    inFlightUntil: c.inFlightUntil,
    fetchedAt: c.fetchedAt ?? null,
    results: c.results ?? null,
    fetchError: c.fetchError ?? null,
    lastGood,
    failures: c.failures,
    nextAt: c.nextAt,
  };
}
