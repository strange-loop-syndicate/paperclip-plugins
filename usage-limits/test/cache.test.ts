import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFailure,
  applyResponse,
  backoffMs,
  BASE_INTERVAL_MS,
  emptyCache,
  IN_FLIGHT_TTL_MS,
  MANUAL_MIN_GAP_MS,
  markInFlight,
  MAX_BACKOFF_MS,
  parseCache,
  retryAt,
  shouldFetch,
  type QuotaCache,
} from "../src/cache.ts";
import type { ProviderQuotaResult } from "../src/mapping.ts";

const T0 = Date.parse("2026-10-23T12:00:00.000Z");
const MIN = 60_000;
const USED = ["anthropic", "openai"];

const CLAUDE_OK: ProviderQuotaResult = {
  provider: "anthropic",
  source: "anthropic-oauth",
  ok: true,
  windows: [{ label: "Current session", usedPercent: 82, resetsAt: null, valueLabel: null }],
};
const CLAUDE_429: ProviderQuotaResult = {
  provider: "anthropic",
  ok: false,
  error: "anthropic usage api returned 429",
  windows: [],
};
const CODEX_OK: ProviderQuotaResult = {
  provider: "openai",
  ok: true,
  windows: [{ label: "5h limit", usedPercent: 0, resetsAt: null, valueLabel: null }],
};
const GEMINI_FAIL: ProviderQuotaResult = { provider: "gemini_local", ok: false, error: "no auth", windows: [] };

/** One completed fetch at `at`, as a tab would run it. */
function fetchAt(cache: QuotaCache | null, at: number, results: ProviderQuotaResult[]): QuotaCache {
  return applyResponse(markInFlight(cache, at), results, at + 2_000, USED);
}

test("backoff: 5 min normally, doubling to a 30 min cap after failures", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 50].map((n) => backoffMs(n) / MIN),
    [5, 10, 20, 30, 30, 30],
  );
  assert.equal(backoffMs(-1), BASE_INTERVAL_MS);
});

test("first load fetches; then nothing until 5 min have passed, across tabs", () => {
  assert.deepEqual(shouldFetch(null, T0, { manual: false }), { fetch: true });
  const c = fetchAt(null, T0, [CLAUDE_OK, CODEX_OK]);
  assert.equal(c.failures, 0);
  assert.equal(c.nextAt, T0 + 2_000 + 5 * MIN);
  // A second tab reading the same entry at +1 min and +4 min does not fetch.
  assert.equal(shouldFetch(c, T0 + 1 * MIN, { manual: false }).fetch, false);
  const at4 = shouldFetch(c, T0 + 4 * MIN, { manual: false });
  assert.deepEqual(at4, { fetch: false, reason: "fresh", waitMs: 1 * MIN + 2_000 });
  assert.deepEqual(shouldFetch(c, T0 + 5 * MIN + 2_000, { manual: false }), { fetch: true });
});

test("a running fetch in another tab blocks both automatic and manual fetches", () => {
  const started = markInFlight(fetchAt(null, T0 - 10 * MIN, [CLAUDE_OK, CODEX_OK]), T0);
  assert.equal(shouldFetch(started, T0 + 5_000, { manual: false }).fetch, false);
  const manual = shouldFetch(started, T0 + 5_000, { manual: true });
  assert.equal(manual.fetch, false);
  assert.equal(!manual.fetch && manual.reason, "in-flight");
});

test("a tab closed mid-fetch does not block the others for longer than the in-flight TTL + gap", () => {
  const abandoned = markInFlight(fetchAt(null, T0 - 10 * MIN, [CLAUDE_OK, CODEX_OK]), T0);
  assert.equal(shouldFetch(abandoned, T0 + IN_FLIGHT_TTL_MS + 1, { manual: false }).fetch, false, "60 s gap still applies");
  assert.deepEqual(shouldFetch(abandoned, T0 + MANUAL_MIN_GAP_MS, { manual: false }), { fetch: true });
});

test("a 429 on a used provider backs off 10, 20, 30, 30 min and keeps the last good windows", () => {
  let c = fetchAt(null, T0, [CLAUDE_OK, CODEX_OK]);
  let t = c.nextAt;
  const waits: number[] = [];
  for (let i = 0; i < 4; i++) {
    assert.equal(shouldFetch(c, t, { manual: false }).fetch, true);
    c = applyResponse(markInFlight(c, t), [CLAUDE_429, CODEX_OK], t, USED);
    waits.push((c.nextAt - t) / MIN);
    assert.equal(shouldFetch(c, t + 9 * MIN, { manual: false }).fetch, false, "no automatic fetch while backing off");
    t = c.nextAt;
  }
  assert.deepEqual(waits, [10, 20, 30, 30]);
  assert.equal(c.failures, 4);
  assert.equal(retryAt(c), c.nextAt);
  assert.deepEqual(c.lastGood.anthropic.windows, CLAUDE_OK.windows, "older good Claude data survives");
  assert.equal(c.lastGood.anthropic.fetchedAt, T0 + 2_000);

  // Recovery resets the interval to 5 min and clears the retry time.
  c = applyResponse(markInFlight(c, t), [CLAUDE_OK, CODEX_OK], t, USED);
  assert.equal(c.failures, 0);
  assert.equal(c.nextAt - t, 5 * MIN);
  assert.equal(retryAt(c), null);
});

test("a failing provider that no agent uses does not cause a backoff", () => {
  const c = fetchAt(null, T0, [CLAUDE_OK, CODEX_OK, GEMINI_FAIL]);
  assert.equal(c.failures, 0);
  const onlyClaude = applyResponse(null, [CLAUDE_OK, CODEX_OK, CLAUDE_429], T0, ["anthropic"]);
  assert.equal(onlyClaude.failures, 0, "an ok duplicate wins over a failed one");
});

test("a missing used provider counts as a failure", () => {
  const c = applyResponse(null, [CLAUDE_OK], T0, USED);
  assert.equal(c.failures, 1);
});

test("a failed request keeps last good data and backs off", () => {
  const ok = fetchAt(null, T0, [CLAUDE_OK, CODEX_OK]);
  const failed = applyFailure(markInFlight(ok, T0 + 6 * MIN), "Failed to fetch", T0 + 6 * MIN);
  assert.equal(failed.results, null);
  assert.equal(failed.fetchError, "Failed to fetch");
  assert.equal(failed.inFlightUntil, 0);
  assert.equal(failed.failures, 1);
  assert.equal(failed.nextAt, T0 + 16 * MIN);
  assert.deepEqual(Object.keys(failed.lastGood).sort(), ["anthropic", "openai"]);
  const next = applyResponse(failed, [CLAUDE_OK, CODEX_OK], T0 + 16 * MIN, USED);
  assert.equal(next.fetchError, null);
});

test("manual refresh ignores the backoff but obeys the 60 s minimum gap", () => {
  const c = applyResponse(markInFlight(null, T0), [CLAUDE_429, CODEX_OK], T0, USED);
  const tooSoon = shouldFetch(c, T0 + 20_000, { manual: true });
  assert.deepEqual(tooSoon, { fetch: false, reason: "min-gap", waitMs: 40_000 });
  assert.deepEqual(shouldFetch(c, T0 + MANUAL_MIN_GAP_MS, { manual: true }), { fetch: true });
  const auto = shouldFetch(c, T0 + MANUAL_MIN_GAP_MS, { manual: false });
  assert.equal(!auto.fetch && auto.reason, "backoff");
});

test("a far-future timestamp (clock change, bad data) cannot block fetching", () => {
  const broken: QuotaCache = { ...emptyCache(), lastAttemptAt: T0 - 10 * MIN, nextAt: T0 + 365 * 24 * 60 * MIN, inFlightUntil: T0 + 24 * 60 * MIN };
  assert.deepEqual(shouldFetch(broken, T0, { manual: false }), { fetch: true });
  const futureAttempt: QuotaCache = { ...emptyCache(), lastAttemptAt: T0 + 60 * MIN };
  assert.deepEqual(shouldFetch(futureAttempt, T0, { manual: true }), { fetch: true });
  assert.ok(MAX_BACKOFF_MS < 365 * 24 * 60 * MIN);
});

test("parseCache round-trips a stored entry and rejects foreign or broken values", () => {
  const c = fetchAt(null, T0, [CLAUDE_OK, CODEX_OK]);
  assert.deepEqual(parseCache(JSON.stringify(c)), c);
  assert.equal(parseCache(null), null);
  assert.equal(parseCache("not json"), null);
  assert.equal(parseCache("[]"), null);
  assert.equal(parseCache(JSON.stringify({ ...c, v: 2 })), null);
  assert.equal(parseCache(JSON.stringify({ ...c, nextAt: "soon" })), null);
  assert.equal(parseCache(JSON.stringify({ ...c, results: {} })), null);
  const dropped = parseCache(JSON.stringify({ ...c, lastGood: { ...c.lastGood, bad: { windows: "x" } } }));
  assert.deepEqual(Object.keys(dropped?.lastGood ?? {}).sort(), ["anthropic", "openai"]);
});
