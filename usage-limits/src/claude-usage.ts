// Claude usage for the active account, read in the worker (Node), the same
// way as the interactive status line (~/.claude/hooks/statusline.sh,
// `refresh_usage_api`): the Anthropic OAuth usage API, cached in
// ~/.claude/usage-exact.json. Both share that file and the status line's lock
// directory, so together they poll the API at most once per FRESH_MS.
//
// The token comes from the file store only (`.credentials.json`). Never the
// keychain: a locked keychain opens a modal password dialog. The token stays
// in this module: it is never logged, cached or returned.
//
// The account name comes from the token itself (`/api/oauth/profile`, as cca
// does), not from `.claude.json`: live sessions rewrite that file's
// `oauthAccount` from their own copy, so it can name the previous account.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
/** Interactive sessions refresh the cache every 60 s; the plugin uses the same interval. */
export const FRESH_MS = 60_000;
/** The status line reaps a lock older than 30 s (its API call is bounded to 3 s). */
export const LOCK_STALE_MS = 30_000;
export const FETCH_TIMEOUT_MS = 5_000;
/** The status line's lock directory (`LOCK_DIR` in statusline.sh). */
export const STATUSLINE_LOCK_DIR = "/tmp/statusline-refresh.lock.d";

export interface ClaudePaths {
  credentialsFile: string;
  usageFile: string;
  lockDir: string;
  /** Holds `oauthAccount.emailAddress`; only a fallback for the account name. */
  accountFile: string;
}

/** Same paths as Claude Code, cca and the status line: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function defaultPaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): ClaudePaths {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  return {
    credentialsFile: path.join(configDir, ".credentials.json"),
    usageFile: path.join(home, ".claude", "usage-exact.json"),
    lockDir: STATUSLINE_LOCK_DIR,
    accountFile: env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json"),
  };
}

export interface ClaudeWindow {
  /** Percent used as the API reports it; null when unknown. */
  utilization: number | null;
  /** Reset time (ms epoch); null when unknown. */
  resetsAt: number | null;
}

export interface ClaudeUsage {
  fiveHour: ClaudeWindow | null;
  sevenDay: ClaudeWindow | null;
  /** When the API was read (ms epoch); null when there is no reading. */
  asOf: number | null;
  /** Email of the account the token belongs to; null when unknown. */
  account: string | null;
  /** Why the reading is missing or old; null when it is fresh. */
  reason: string | null;
}

/** In-memory state between calls; one per worker. */
export interface UsageState {
  /** No API call before this time (ms epoch), from a `Retry-After` header. */
  retryAfterUntil: number;
  /** Why the last refresh failed; cleared by a good reading. */
  lastError: string | null;
  /** Account email per token fingerprint (a hash, not the token). */
  profile: { fingerprint: string; email: string } | null;
  /** No profile call before this time (ms epoch) after a failed one. */
  profileRetryAt: number;
}

export function newUsageState(): UsageState {
  return { retryAfterUntil: 0, lastError: null, profile: null, profileRetryAt: 0 };
}

export interface UsageDeps {
  paths: ClaudePaths;
  fetch: typeof fetch;
  now: () => number;
}

/** The shape statusline.sh writes to usage-exact.json. */
interface CacheFile {
  timestamp?: unknown;
  source?: unknown;
  metrics?: {
    session?: { percent_used?: unknown; resets_at?: unknown } | null;
    week_all?: { percent_used?: unknown; resets_at?: unknown } | null;
  } | null;
}

interface CacheReading {
  fiveHour: ClaudeWindow | null;
  sevenDay: ClaudeWindow | null;
  asOf: number;
  mtimeMs: number;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function cacheWindow(w: { percent_used?: unknown; resets_at?: unknown } | null | undefined): ClaudeWindow | null {
  if (!w || typeof w !== "object") return null;
  const utilization = num(w.percent_used);
  const resetsAt = isoMs(w.resets_at);
  return utilization === null && resetsAt === null ? null : { utilization, resetsAt };
}

/** Parse usage-exact.json; null when absent or not the expected shape. */
export function parseCacheFile(raw: string, mtimeMs: number): CacheReading | null {
  let body: CacheFile;
  try {
    body = JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || !body.metrics || typeof body.metrics !== "object") return null;
  const fiveHour = cacheWindow(body.metrics.session);
  const sevenDay = cacheWindow(body.metrics.week_all);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, asOf: isoMs(body.timestamp) ?? mtimeMs, mtimeMs };
}

interface ApiWindow {
  utilization?: unknown;
  resets_at?: unknown;
}

/**
 * API response → the file statusline.sh writes, byte-compatible in shape:
 * `{timestamp, source: "api", metrics: {session, week_all, week_sonnet}}`.
 * Null when the response has no 5-hour utilization (the status line's own check).
 */
export function cacheFileFromApi(body: unknown, now: number): object | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { five_hour?: ApiWindow | null; seven_day?: ApiWindow | null; seven_day_sonnet?: ApiWindow | null };
  if (num(b.five_hour?.utilization) === null) return null;
  const metric = (w: ApiWindow | null | undefined) => {
    const used = num(w?.utilization);
    return {
      percent_used: used,
      percent_remaining: used === null ? null : 100 - used,
      resets_at: typeof w?.resets_at === "string" ? w.resets_at : null,
    };
  };
  return {
    // jq `now | todate` writes whole seconds: "2026-10-27T05:02:22Z".
    timestamp: new Date(Math.floor(now / 1000) * 1000).toISOString().replace(".000Z", "Z"),
    source: "api",
    metrics: {
      session: metric(b.five_hour),
      week_all: b.seven_day ? metric(b.seven_day) : null,
      week_sonnet: b.seven_day_sonnet ? metric(b.seven_day_sonnet) : null,
    },
  };
}

async function readCache(file: string): Promise<CacheReading | null> {
  try {
    const [raw, st] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    return parseCacheFile(raw, st.mtimeMs);
  } catch {
    return null;
  }
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** Account email from `oauthAccount.emailAddress`; null when unknown. */
export async function readAccount(file: string): Promise<string | null> {
  try {
    const body = JSON.parse(await readFile(file, "utf8")) as { oauthAccount?: { emailAddress?: unknown } | null };
    const email = body?.oauthAccount?.emailAddress;
    return typeof email === "string" && email ? email : null;
  } catch {
    return null;
  }
}

type TokenResult = { token: string; fingerprint: string } | { error: string };

/** The OAuth access token from the file store. Errors never contain the token. */
async function readToken(file: string, now: number): Promise<TokenResult> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return { error: `No Claude credentials file (${file}); sign in with Claude Code` };
  }
  let oauth: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown } | undefined;
  try {
    oauth = (JSON.parse(raw) as { claudeAiOauth?: typeof oauth }).claudeAiOauth;
  } catch {
    return { error: `Claude credentials file is not valid JSON (${file})` };
  }
  const token = typeof oauth?.accessToken === "string" ? oauth.accessToken : "";
  if (!token) return { error: `No OAuth token in the Claude credentials file (${file})` };
  const expiresAt = num(oauth?.expiresAt);
  if (expiresAt !== null && expiresAt <= now) {
    return { error: "Claude OAuth token in the credentials file has expired; Claude Code renews it on its next run" };
  }
  // Keyed on the refresh token: it changes on an account switch (and on a renewal, which costs one profile call).
  const refreshToken = typeof oauth?.refreshToken === "string" ? oauth.refreshToken : "";
  return { token, fingerprint: createHash("sha256").update(refreshToken || token).digest("hex").slice(0, 16) };
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "Content-Type": "application/json",
  };
}

/**
 * Email of the account the token belongs to, from the profile API; one call
 * per token (fingerprint), kept in memory. When that fails, the email cached
 * in `.claude.json`, marked as such: live sessions can leave it stale.
 */
async function resolveAccount(deps: UsageDeps, state: UsageState, creds: TokenResult, now: number): Promise<string | null> {
  if ("token" in creds) {
    if (state.profile?.fingerprint === creds.fingerprint) return state.profile.email;
    if (now >= state.profileRetryAt) {
      try {
        const res = await deps.fetch(PROFILE_URL, { headers: authHeaders(creds.token), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        const body = res.ok ? ((await res.json()) as { account?: { email?: unknown } | null }) : null;
        const email = body?.account?.email;
        if (typeof email === "string" && email) {
          state.profile = { fingerprint: creds.fingerprint, email };
          return email;
        }
      } catch {
        // fall through to the cached identity
      }
      state.profileRetryAt = now + FRESH_MS;
    }
  }
  const cached = await readAccount(deps.paths.accountFile);
  return cached ? `${cached} (from .claude.json, may lag an account switch)` : null;
}

/** `Retry-After` in ms: delta seconds or an HTTP date; null when absent or invalid. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Take the shared lock directory, reaping one left behind by a dead holder. */
async function takeLock(dir: string, now: number): Promise<boolean> {
  try {
    await mkdir(dir);
    return true;
  } catch {
    const at = await mtimeOf(dir);
    if (at === null || now - at <= LOCK_STALE_MS) return false;
    try {
      await rmdir(dir);
      await mkdir(dir);
      return true;
    } catch {
      return false;
    }
  }
}

async function writeCacheAtomically(file: string, body: object): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

function isFresh(cache: CacheReading | null, credentialsMtime: number | null, now: number): cache is CacheReading {
  if (!cache || now - cache.mtimeMs >= FRESH_MS) return false;
  // An account switch rewrites the credentials file: a reading older than that may belong to the previous account.
  return credentialsMtime === null || cache.mtimeMs >= credentialsMtime;
}

function result(cache: CacheReading | null, account: string | null, reason: string | null): ClaudeUsage {
  return {
    fiveHour: cache?.fiveHour ?? null,
    sevenDay: cache?.sevenDay ?? null,
    asOf: cache?.asOf ?? null,
    account,
    reason,
  };
}

/** Reason for a reading kept after a failed refresh; says when it may be from another account. */
function keptReason(error: string, cache: CacheReading | null, credentialsMtime: number | null): string {
  if (cache && credentialsMtime !== null && cache.mtimeMs < credentialsMtime) {
    return `${error}; the shown reading predates the last credentials change and may be for the previous account`;
  }
  return error;
}

/**
 * Claude usage for the active account. Uses usage-exact.json when it is
 * younger than FRESH_MS; else, under the shared lock, calls the usage API and
 * rewrites that file. On any failure the last good file value stays, with the
 * reason. A `Retry-After` pauses calls; without one the next tick retries.
 */
export async function getClaudeUsage(deps: UsageDeps, state: UsageState): Promise<ClaudeUsage> {
  const { paths } = deps;
  const now = deps.now();
  const [creds, credentialsMtime] = await Promise.all([readToken(paths.credentialsFile, now), mtimeOf(paths.credentialsFile)]);
  const account = await resolveAccount(deps, state, creds, now);
  let cache = await readCache(paths.usageFile);
  if (isFresh(cache, credentialsMtime, now)) {
    state.lastError = null;
    return result(cache, account, null);
  }
  const kept = (error: string) => {
    state.lastError = error;
    return result(cache, account, keptReason(error, cache, credentialsMtime));
  };
  if (now < state.retryAfterUntil) {
    return result(cache, account, keptReason(state.lastError ?? "Usage API asked to wait", cache, credentialsMtime));
  }
  if (!(await takeLock(paths.lockDir, now))) {
    // Another refresher (status line or this worker) holds the lock; its result shows on the next tick.
    return result(cache, account, state.lastError ? keptReason(state.lastError, cache, credentialsMtime) : null);
  }
  try {
    cache = await readCache(paths.usageFile);
    if (isFresh(cache, credentialsMtime, now)) {
      state.lastError = null;
      return result(cache, account, null);
    }
    if ("error" in creds) return kept(creds.error);
    let res: Response;
    try {
      res = await deps.fetch(USAGE_URL, { headers: authHeaders(creds.token), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      return kept(name === "TimeoutError" ? "Usage API did not answer in time" : "Usage API request failed (network)");
    }
    if (res.status === 429) {
      const wait = retryAfterMs(res.headers.get("retry-after"), now);
      if (wait !== null) state.retryAfterUntil = now + wait;
      return kept(wait !== null ? `Usage API throttled (429), retry after ${Math.ceil(wait / 1000)} s` : "Usage API throttled (429)");
    }
    if (res.status === 401 || res.status === 403) return kept(`Usage API rejected the token (${res.status})`);
    if (!res.ok) return kept(`Usage API returned ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return kept("Usage API response was not JSON");
    }
    const file = cacheFileFromApi(body, now);
    if (!file) return kept("Usage API response had no 5-hour utilization");
    await writeCacheAtomically(paths.usageFile, file);
    state.lastError = null;
    state.retryAfterUntil = 0;
    const written = await readCache(paths.usageFile);
    return result(written, account, written ? null : "Could not read back usage-exact.json");
  } catch (err) {
    return kept(`Could not refresh Claude usage (${err instanceof Error ? err.message.replace(/Bearer\s+\S+/g, "Bearer …") : "error"})`);
  } finally {
    await rmdir(paths.lockDir).catch(() => {});
  }
}
