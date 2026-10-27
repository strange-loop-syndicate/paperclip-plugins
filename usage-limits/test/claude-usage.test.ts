import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cacheFileFromApi,
  defaultPaths,
  getClaudeUsage,
  FRESH_MS,
  newUsageState,
  PROFILE_URL,
  retryAfterMs,
  USAGE_URL,
  type ClaudePaths,
  type UsageDeps,
} from "../src/claude-usage.ts";

const TOKEN = "sk-ant-oat01-TEST-TOKEN-must-never-leak";
const MIN = 60_000;

/** usage-exact.json as statusline.sh writes it. */
function cacheBody(session: number, week: number, timestamp = "2026-10-27T05:02:22Z") {
  return {
    timestamp,
    source: "api",
    metrics: {
      session: { percent_used: session, percent_remaining: 100 - session, resets_at: "2099-01-01T05:29:59.634276+00:00" },
      week_all: { percent_used: week, percent_remaining: 100 - week, resets_at: "2099-01-04T06:59:59.634317+00:00" },
      week_sonnet: null,
    },
  };
}

const API_BODY = {
  five_hour: { utilization: 7, resets_at: "2099-01-01T10:00:00+00:00" },
  seven_day: { utilization: 42, resets_at: "2099-01-05T10:00:00+00:00" },
  seven_day_sonnet: null,
};

interface Setup {
  paths: ClaudePaths;
  /** Usage API calls only. */
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  profileCalls: number;
  deps: UsageDeps;
  setResponse(r: () => Response | Promise<Response>): void;
  setProfile(r: () => Response | Promise<Response>): void;
  now: number;
}

async function setup(opts: { cacheAgeMs?: number | null; credentials?: object | null; credsAgeMs?: number; email?: string } = {}): Promise<Setup> {
  const dir = await mkdtemp(path.join(tmpdir(), "usage-limits-test-"));
  const paths: ClaudePaths = {
    credentialsFile: path.join(dir, ".credentials.json"),
    usageFile: path.join(dir, "usage-exact.json"),
    lockDir: path.join(dir, "statusline-refresh.lock.d"),
  };
  const now = Date.now();
  const setMtime = (file: string, ageMs: number) => utimes(file, (now - ageMs) / 1000, (now - ageMs) / 1000);
  const credentials =
    opts.credentials === undefined
      ? { claudeAiOauth: { accessToken: TOKEN, refreshToken: "refresh-A", expiresAt: now + 3_600_000 } }
      : opts.credentials;
  if (credentials) {
    await writeFile(paths.credentialsFile, JSON.stringify(credentials));
    await setMtime(paths.credentialsFile, opts.credsAgeMs ?? 60 * MIN);
  }
  if (opts.cacheAgeMs !== null) {
    await writeFile(paths.usageFile, JSON.stringify(cacheBody(1, 16)));
    await setMtime(paths.usageFile, opts.cacheAgeMs ?? 10_000);
  }
  let respond: () => Response | Promise<Response> = () => Response.json(API_BODY);
  let profile: () => Response | Promise<Response> = () => Response.json({ account: { email: opts.email ?? "owner@example.com" } });
  const calls: Setup["calls"] = [];
  const s: Setup = {
    paths,
    calls,
    profileCalls: 0,
    deps: {
      paths,
      now: () => now,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === PROFILE_URL) {
          s.profileCalls += 1;
          return profile();
        }
        calls.push({ url: String(url), init });
        return respond();
      }) as typeof fetch,
    },
    setResponse: (r) => (respond = r),
    setProfile: (r) => (profile = r),
    now,
  };
  return s;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

test("fresh cache (< 60 s) is used without an API call", async () => {
  const s = await setup({ cacheAgeMs: 20_000 });
  const usage = await getClaudeUsage(s.deps, newUsageState());
  assert.equal(s.calls.length, 0);
  assert.deepEqual(usage.fiveHour, { utilization: 1, resetsAt: Date.parse("2099-01-01T05:29:59.634Z") });
  assert.equal(usage.sevenDay?.utilization, 16);
  assert.equal(usage.asOf, Date.parse("2026-10-27T05:02:22Z"));
  assert.equal(usage.account, "owner@example.com", "named by the token's own profile");
  assert.equal(usage.reason, null);
});

test("stale cache is refreshed from the API and rewritten in the status line's shape", async () => {
  const s = await setup({ cacheAgeMs: 90_000 });
  const usage = await getClaudeUsage(s.deps, newUsageState());
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].url, USAGE_URL);
  const headers = s.calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(usage.fiveHour?.utilization, 7);
  assert.equal(usage.sevenDay?.utilization, 42);
  assert.equal(usage.reason, null);

  const file = JSON.parse(await readFile(s.paths.usageFile, "utf8"));
  assert.equal(file.source, "api");
  assert.match(file.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.deepEqual(file.metrics.session, { percent_used: 7, percent_remaining: 93, resets_at: "2099-01-01T10:00:00+00:00" });
  assert.deepEqual(file.metrics.week_all, { percent_used: 42, percent_remaining: 58, resets_at: "2099-01-05T10:00:00+00:00" });
  assert.equal(file.metrics.week_sonnet, null);
  assert.equal(await exists(s.paths.lockDir), false, "lock released");
  assert.equal(await exists(`${s.paths.usageFile}.tmp`), false, "no temp file left");
});

test("no cache file at all: the API is called and the file created", async () => {
  const s = await setup({ cacheAgeMs: null });
  const usage = await getClaudeUsage(s.deps, newUsageState());
  assert.equal(s.calls.length, 1);
  assert.equal(usage.fiveHour?.utilization, 7);
  assert.equal(await exists(s.paths.usageFile), true);
});

test("account switch: credentials newer than a fresh-looking cache force a refresh", async () => {
  const s = await setup({ cacheAgeMs: 30_000, credsAgeMs: 5_000, email: "other@example.com" });
  const usage = await getClaudeUsage(s.deps, newUsageState());
  assert.equal(s.calls.length, 1, "the cache may belong to the previous account");
  assert.equal(usage.fiveHour?.utilization, 7);
  assert.equal(usage.account, "other@example.com");
});

test("account: one profile call per token, a new one after an account switch", async () => {
  const s = await setup({ cacheAgeMs: 10_000 });
  const state = newUsageState();
  assert.equal((await getClaudeUsage(s.deps, state)).account, "owner@example.com");
  assert.equal((await getClaudeUsage(s.deps, state)).account, "owner@example.com");
  assert.equal(s.profileCalls, 1, "cached in memory per token");

  // `cca use o`: another account's token lands in the credentials file.
  await writeFile(s.paths.credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: `${TOKEN}-B`, refreshToken: "refresh-B", expiresAt: s.now + 3_600_000 } }));
  s.setProfile(() => Response.json({ account: { email: "second@example.com" } }));
  const after = await getClaudeUsage(s.deps, state);
  assert.equal(s.profileCalls, 2);
  assert.equal(after.account, "second@example.com");
  assert.equal(s.calls.length, 1, "credentials newer than the cache: usage re-read for the new account");
  assert.equal(after.fiveHour?.utilization, 7);
});

test("account: a failed profile call gives unknown (null) and waits a tick", async () => {
  const s = await setup({ cacheAgeMs: 10_000 });
  s.setProfile(() => new Response("", { status: 429 }));
  const state = newUsageState();
  const usage = await getClaudeUsage(s.deps, state);
  assert.equal(usage.account, null);
  assert.equal(usage.fiveHour?.utilization, 1, "numbers still shown");
  await getClaudeUsage(s.deps, state);
  assert.equal(s.profileCalls, 1, "no retry before the next 60 s tick");
});

test("account: after a token change the earlier email is never reused", async () => {
  const s = await setup({ cacheAgeMs: 10_000 });
  const state = newUsageState();
  assert.equal((await getClaudeUsage(s.deps, state)).account, "owner@example.com");
  await writeFile(s.paths.credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: `${TOKEN}-B`, refreshToken: "refresh-B", expiresAt: s.now + 3_600_000 } }));
  s.setProfile(() => Promise.reject(new Error("network")));
  assert.equal((await getClaudeUsage(s.deps, state)).account, null);
});

test("account: no readable credentials means unknown, with no profile call", async () => {
  const s = await setup({ cacheAgeMs: 10_000, credentials: null });
  const usage = await getClaudeUsage(s.deps, newUsageState());
  assert.equal(usage.account, null);
  assert.equal(s.profileCalls, 0);
});

test("429 keeps the last good value with its time and the reason", async () => {
  const s = await setup({ cacheAgeMs: 5 * MIN });
  s.setResponse(() => new Response("", { status: 429 }));
  const state = newUsageState();
  const usage = await getClaudeUsage(s.deps, state);
  assert.equal(s.calls.length, 1);
  assert.equal(usage.fiveHour?.utilization, 1, "last good value kept");
  assert.equal(usage.sevenDay?.utilization, 16);
  assert.equal(usage.asOf, Date.parse("2026-10-27T05:02:22Z"), "age stays the old reading's");
  assert.equal(usage.reason, "Usage API throttled (429)");
  assert.equal(JSON.parse(await readFile(s.paths.usageFile, "utf8")).metrics.session.percent_used, 1, "file untouched");

  // No Retry-After: no call before the next 60 s tick, however often tabs ask.
  const again = await getClaudeUsage(s.deps, state);
  await getClaudeUsage({ ...s.deps, now: () => s.now + 59_999 }, state);
  assert.equal(s.calls.length, 1, "one poll per 60 s");
  assert.equal(again.fiveHour?.utilization, 1);
  assert.equal(again.reason, "Usage API throttled (429)");
  await getClaudeUsage({ ...s.deps, now: () => s.now + FRESH_MS }, state);
  assert.equal(s.calls.length, 2, "the next tick tries again");
});

test("every failed attempt waits 60 s: network, 401, 5xx, bad body", async () => {
  for (const [respond, reason] of [
    [() => Promise.reject(new Error("socket hang up")), "Usage API request failed (network)"],
    [() => new Response("", { status: 401 }), "Usage API rejected the token (401)"],
    [() => new Response("", { status: 503 }), "Usage API returned 503"],
    [() => Response.json({}), "Usage API response had no 5-hour utilization"],
  ] as const) {
    const s = await setup({ cacheAgeMs: 5 * MIN });
    s.setResponse(respond);
    const state = newUsageState();
    assert.equal((await getClaudeUsage(s.deps, state)).reason, reason);
    await getClaudeUsage(s.deps, state);
    assert.equal(s.calls.length, 1, `${reason}: no second call within 60 s`);
    s.setResponse(() => Response.json(API_BODY));
    const next = await getClaudeUsage({ ...s.deps, now: () => s.now + FRESH_MS }, state);
    assert.equal(s.calls.length, 2);
    assert.equal(next.reason, null, "a success clears the pause and the reason");
    await getClaudeUsage({ ...s.deps, now: () => s.now + FRESH_MS + 1 }, state);
    assert.equal(s.calls.length, 2, "the fresh file serves the next call");
  }
});

test("a Retry-After shorter than 60 s still waits the 60 s tick", async () => {
  const s = await setup({ cacheAgeMs: 5 * MIN });
  s.setResponse(() => new Response("", { status: 429, headers: { "retry-after": "5" } }));
  const state = newUsageState();
  await getClaudeUsage(s.deps, state);
  await getClaudeUsage({ ...s.deps, now: () => s.now + 10_000 }, state);
  assert.equal(s.calls.length, 1);
});

test("429 with Retry-After: no call until it has passed", async () => {
  const s = await setup({ cacheAgeMs: 5 * MIN });
  s.setResponse(() => new Response("", { status: 429, headers: { "retry-after": "300" } }));
  const state = newUsageState();
  const first = await getClaudeUsage(s.deps, state);
  assert.equal(first.reason, "Usage API throttled (429), retry after 300 s");
  const second = await getClaudeUsage(s.deps, state);
  assert.equal(s.calls.length, 1, "honors Retry-After");
  assert.equal(second.fiveHour?.utilization, 1);
  assert.equal(second.reason, "Usage API throttled (429), retry after 300 s");

  const later = { ...s.deps, now: () => s.now + 301_000 };
  s.setResponse(() => Response.json(API_BODY));
  const third = await getClaudeUsage(later, state);
  assert.equal(s.calls.length, 2);
  assert.equal(third.fiveHour?.utilization, 7);
  assert.equal(third.reason, null);
});

test("missing credentials give a clear reason and no API call", async () => {
  const s = await setup({ cacheAgeMs: null, credentials: null });
  const usage = await getClaudeUsage(s.deps, newUsageState());
  assert.equal(s.calls.length, 0);
  assert.equal(usage.fiveHour, null);
  assert.equal(usage.asOf, null);
  assert.match(usage.reason ?? "", /^No Claude credentials file \(.*\.credentials\.json\); sign in with Claude Code$/);
});

test("credentials without a token, or with an expired one, give a reason and no call", async () => {
  const noToken = await setup({ cacheAgeMs: null, credentials: { claudeAiOauth: {} } });
  assert.match((await getClaudeUsage(noToken.deps, newUsageState())).reason ?? "", /^No OAuth token/);
  const expired = await setup({ cacheAgeMs: null, credentials: { claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() - 1 } } });
  assert.match((await getClaudeUsage(expired.deps, newUsageState())).reason ?? "", /token .* has expired/);
  assert.equal(noToken.calls.length + expired.calls.length, 0);
});

test("a lock held by the status line means no second call; a dead lock is reaped", async () => {
  const s = await setup({ cacheAgeMs: 90_000 });
  await mkdir(s.paths.lockDir);
  const held = await getClaudeUsage(s.deps, newUsageState());
  assert.equal(s.calls.length, 0);
  assert.equal(held.fiveHour?.utilization, 1, "serves the cached value meanwhile");
  assert.equal(await exists(s.paths.lockDir), true, "another holder's lock is left alone");

  await utimes(s.paths.lockDir, (s.now - 31_000) / 1000, (s.now - 31_000) / 1000);
  const reaped = await getClaudeUsage(s.deps, newUsageState());
  assert.equal(s.calls.length, 1);
  assert.equal(reaped.fiveHour?.utilization, 7);
});

test("the token never reaches the result, even when an error message carries it", async () => {
  const s = await setup({ cacheAgeMs: 90_000 });
  for (const respond of [
    () => Promise.reject(new Error(`boom Bearer ${TOKEN}`)),
    () => new Response("", { status: 401 }),
    () => new Response("not json", { status: 200 }),
    () => Response.json({ error: TOKEN }),
  ]) {
    s.setProfile(() => Promise.reject(new Error(`profile Bearer ${TOKEN}`)));
    s.setResponse(respond);
    const usage = await getClaudeUsage(s.deps, newUsageState());
    assert.ok(usage.reason, "a reason is given");
    assert.doesNotMatch(JSON.stringify(usage), new RegExp(TOKEN));
  }
});

test("cacheFileFromApi refuses a response without 5-hour utilization", () => {
  assert.equal(cacheFileFromApi({ seven_day: { utilization: 3 } }, Date.now()), null);
  assert.equal(cacheFileFromApi(null, Date.now()), null);
});

test("retryAfterMs reads seconds and HTTP dates", () => {
  const now = Date.parse("2026-10-27T05:00:00Z");
  assert.equal(retryAfterMs("120", now), 120_000);
  assert.equal(retryAfterMs("Tue, 27 Oct 2026 05:01:00 GMT", now), 60_000);
  assert.equal(retryAfterMs(null, now), null);
  assert.equal(retryAfterMs("soon", now), null);
});

test("defaultPaths follow CLAUDE_CONFIG_DIR like Claude Code; the cache stays in ~/.claude", () => {
  assert.deepEqual(defaultPaths({}, "/home/u"), {
    credentialsFile: "/home/u/.claude/.credentials.json",
    usageFile: "/home/u/.claude/usage-exact.json",
    lockDir: "/tmp/statusline-refresh.lock.d",
  });
  const custom = defaultPaths({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u");
  assert.equal(custom.credentialsFile, "/cfg/.credentials.json");
  assert.equal(custom.usageFile, "/home/u/.claude/usage-exact.json");
});
