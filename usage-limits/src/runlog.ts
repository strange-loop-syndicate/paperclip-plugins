// Claude limits from heartbeat run logs. Claude Code's stream-json output
// carries `rate_limit_event` lines with the live 5-hour and weekly windows;
// each `claude_local` run log stores that output as escaped `chunk` strings.
// Pure parsing, run selection and cache decisions: no DOM, no fetch, so
// `node --test` can load it. The UI supplies the HTTP reads.

/** One limit window as reported by Claude Code. */
export interface LimitWindow {
  /** Percent used, 0-100 (not rounded); null when not reported. */
  utilization: number | null;
  /** Reset time (ms epoch); null when not reported. */
  resetsAt: number | null;
}

/** The limits from one `rate_limit_event`. */
export interface RateLimitSnapshot {
  /** When the event was logged (ms epoch, from the log line's `ts`). */
  at: number;
  status: string | null;
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  runId?: string | null;
}

/** One run from GET /api/companies/:id/heartbeat-runs?summary=true (fields we use). */
export interface RunSummary {
  id: string;
  agentId: string;
  status?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastOutputAt?: string | null;
  logBytes?: number | null;
  logCompressed?: boolean | null;
}

/** Read `limitBytes` of a run log from byte `offset`; null when the run has no log. */
export type ReadLog = (runId: string, offset: number, limitBytes: number) => Promise<string | null>;

/** Runs scanned per refresh, newest activity first. */
export const SCAN_MAX_RUNS = 6;
/** Bytes read from the end of a finished run's log. */
export const TAIL_BYTES = 256_000;
/** Bytes read from the start of a log: a running run (size unknown), or a tail without an event. */
export const HEAD_BYTES = 64_000;
/** Runs requested from the company run list. */
export const RUN_LIST_LIMIT = 30;
/** A carried-over partial stream line longer than this is dropped. */
const MAX_PARTIAL_CHARS = 1_000_000;

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Claude Code reports reset times in seconds; accept ms too. */
function toMs(value: unknown): number | null {
  if (!finite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

function toWindow(raw: unknown): LimitWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as { utilization?: unknown; resetsAt?: unknown };
  const utilization = finite(w.utilization) ? Math.min(100, Math.max(0, w.utilization * 100)) : null;
  const resetsAt = toMs(w.resetsAt);
  if (utilization === null && resetsAt === null) return null;
  return { utilization, resetsAt };
}

/**
 * Limits from one `rate_limit_info` object. Uses `unifiedWindows` when
 * present; older events carry only the window named by `rateLimitType`.
 */
export function snapshotFromInfo(info: unknown, at: number): RateLimitSnapshot | null {
  if (!info || typeof info !== "object" || !finite(at)) return null;
  const i = info as {
    status?: unknown;
    rateLimitType?: unknown;
    utilization?: unknown;
    resetsAt?: unknown;
    unifiedWindows?: { five_hour?: unknown; seven_day?: unknown } | null;
  };
  let fiveHour: LimitWindow | null = null;
  let sevenDay: LimitWindow | null = null;
  if (i.unifiedWindows && typeof i.unifiedWindows === "object") {
    fiveHour = toWindow(i.unifiedWindows.five_hour);
    sevenDay = toWindow(i.unifiedWindows.seven_day);
  }
  const single = toWindow({ utilization: i.utilization, resetsAt: i.resetsAt });
  if (!fiveHour && i.rateLimitType === "five_hour") fiveHour = single;
  if (!sevenDay && i.rateLimitType === "seven_day") sevenDay = single;
  if (!fiveHour && !sevenDay) return null;
  return { at, status: typeof i.status === "string" ? i.status : null, fiveHour, sevenDay };
}

function parseStreamLine(line: string, at: number): RateLimitSnapshot | null {
  if (!line.includes("rate_limit_event")) return null;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  const e = event as { type?: unknown; rate_limit_info?: unknown };
  if (e.type !== "rate_limit_event") return null;
  return snapshotFromInfo(e.rate_limit_info, at);
}

/**
 * Every `rate_limit_event` in a piece of run log, oldest first.
 *
 * The log is NDJSON: `{"ts", "stream", "chunk", ...}` per line, where `chunk`
 * is raw stdout. One stream-json line can span chunks, so stdout chunks are
 * joined before splitting. A piece read from a byte offset starts mid-line:
 * pass `fromStart: false` and the first, partial log line is skipped.
 */
export function parseRunLog(text: string, opts: { fromStart: boolean; runId?: string | null }): RateLimitSnapshot[] {
  const out: RateLimitSnapshot[] = [];
  const lines = text.split("\n");
  if (!opts.fromStart) lines.shift();
  let pending = "";
  let lastAt = Number.NaN;
  const emit = (line: string, at: number) => {
    const snap = parseStreamLine(line, at);
    if (snap) out.push(opts.runId ? { ...snap, runId: opts.runId } : snap);
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // partial last line of a running log, or foreign text
    }
    if (!record || typeof record !== "object") continue;
    const r = record as { ts?: unknown; stream?: unknown; chunk?: unknown };
    if (typeof r.chunk !== "string") continue;
    if (r.stream !== undefined && r.stream !== "stdout") continue;
    const at = typeof r.ts === "string" ? Date.parse(r.ts) : Number.NaN;
    lastAt = at;
    const parts = (pending + r.chunk).split("\n");
    pending = parts.pop() ?? "";
    if (pending.length > MAX_PARTIAL_CHARS) pending = "";
    for (const part of parts) emit(part, at);
  }
  if (pending) emit(pending, lastAt);
  return out;
}

/** The latest snapshot by log time; on a tie the later one in the list. */
export function newestSnapshot(
  snapshots: ReadonlyArray<RateLimitSnapshot | null | undefined>,
): RateLimitSnapshot | null {
  let best: RateLimitSnapshot | null = null;
  for (const s of snapshots) {
    if (s && (!best || s.at >= best.at)) best = s;
  }
  return best;
}

function parseTime(value: string | null | undefined): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** Latest time the run wrote anything; no event in its log can be newer. */
export function runActivityAt(run: RunSummary): number {
  return Math.max(parseTime(run.finishedAt), parseTime(run.lastOutputAt), parseTime(run.startedAt), parseTime(run.createdAt));
}

/** Runs of the given agents worth reading, newest activity first, at most `max`. */
export function scanCandidates(
  runs: ReadonlyArray<RunSummary>,
  agentIds: ReadonlyArray<string>,
  max: number = SCAN_MAX_RUNS,
): RunSummary[] {
  const ids = new Set(agentIds);
  return runs
    .filter((r) => r && typeof r.id === "string" && ids.has(r.agentId) && r.logCompressed !== true)
    .filter((r) => r.status !== "queued")
    .sort((a, b) => runActivityAt(b) - runActivityAt(a))
    .slice(0, max);
}

export interface ScanResult {
  snapshot: RateLimitSnapshot | null;
  /** Log reads made. */
  reads: number;
  /** Runs looked at. */
  runsRead: number;
  /** Read failures, for the tooltip. */
  errors: string[];
}

/**
 * Newest `rate_limit_event` across the given agents' recent runs.
 *
 * Reads only the tail of a finished log (its size is known), and the head
 * when the tail has no event or the run is still running (size unknown).
 * Stops as soon as no remaining run was active after the newest event found.
 */
export async function scanRuns(
  runs: ReadonlyArray<RunSummary>,
  agentIds: ReadonlyArray<string>,
  readLog: ReadLog,
  limits: { maxRuns?: number; tailBytes?: number; headBytes?: number } = {},
): Promise<ScanResult> {
  const tailBytes = limits.tailBytes ?? TAIL_BYTES;
  const headBytes = limits.headBytes ?? HEAD_BYTES;
  const result: ScanResult = { snapshot: null, reads: 0, runsRead: 0, errors: [] };
  for (const run of scanCandidates(runs, agentIds, limits.maxRuns ?? SCAN_MAX_RUNS)) {
    if (result.snapshot && result.snapshot.at >= runActivityAt(run)) break;
    result.runsRead += 1;
    try {
      const size = finite(run.logBytes) && run.logBytes > 0 ? run.logBytes : null;
      let found: RateLimitSnapshot[] = [];
      if (size !== null && size > tailBytes) {
        const offset = size - tailBytes;
        result.reads += 1;
        const text = await readLog(run.id, offset, tailBytes);
        if (text) found = parseRunLog(text, { fromStart: false, runId: run.id });
      }
      if (found.length === 0) {
        result.reads += 1;
        const limit = size !== null && size <= tailBytes ? size : headBytes;
        const text = await readLog(run.id, 0, limit);
        if (text) found = parseRunLog(text, { fromStart: true, runId: run.id });
      }
      result.snapshot = newestSnapshot([result.snapshot, newestSnapshot(found)]);
    } catch (err) {
      result.errors.push(`run ${run.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

// ---- Shared cache for the run-log scan (one entry per browser) ----

/** How often the run logs are scanned, across all tabs. */
export const RUNLOG_INTERVAL_MS = 2 * 60_000;
/** How long a started scan blocks other tabs. */
export const RUNLOG_IN_FLIGHT_TTL_MS = 30_000;
export const RUNLOG_CACHE_VERSION = 1;

export interface RunLogCache {
  v: typeof RUNLOG_CACHE_VERSION;
  companyId: string | null;
  /** Start of the latest scan (ms epoch). */
  attemptAt: number;
  /** A scan is running until this time (ms epoch); 0 when none. */
  inFlightUntil: number;
  /** End of the latest completed scan (ms epoch); null before the first. */
  checkedAt: number | null;
  /** Newest event seen so far. */
  snapshot: RateLimitSnapshot | null;
  /** Why the latest scan found nothing or failed; null otherwise. */
  error: string | null;
}

export function emptyRunLogCache(companyId: string | null): RunLogCache {
  return { v: RUNLOG_CACHE_VERSION, companyId, attemptAt: 0, inFlightUntil: 0, checkedAt: null, snapshot: null, error: null };
}

/** Is a scan due? Never while another tab's scan runs; otherwise every 2 min, or at once for a new company. */
export function scanDue(cache: RunLogCache | null, companyId: string, now: number): boolean {
  if (!cache || cache.companyId !== companyId) return true;
  if (cache.inFlightUntil > now && cache.inFlightUntil - now <= RUNLOG_IN_FLIGHT_TTL_MS) return false;
  const since = now - cache.attemptAt;
  return since < 0 || since >= RUNLOG_INTERVAL_MS;
}

export function markScanStarted(cache: RunLogCache | null, companyId: string, now: number): RunLogCache {
  const base = cache && cache.companyId === companyId ? cache : emptyRunLogCache(companyId);
  return { ...base, attemptAt: now, inFlightUntil: now + RUNLOG_IN_FLIGHT_TTL_MS };
}

/** Store a scan result. The newer of the old and new snapshots is kept. */
export function applyScan(cache: RunLogCache | null, companyId: string, scan: ScanResult, now: number): RunLogCache {
  const base = cache && cache.companyId === companyId ? cache : emptyRunLogCache(companyId);
  const snapshot = newestSnapshot([base.snapshot, scan.snapshot]);
  let error: string | null = null;
  if (!scan.snapshot) {
    error = scan.errors.length > 0 ? `Run log read failed (${scan.errors[0]})` : "No rate_limit_event in recent Claude run logs";
  }
  return { ...base, inFlightUntil: 0, checkedAt: now, snapshot, error };
}

/** Store a failure of the whole scan (run list request failed). The old snapshot stays. */
export function applyScanFailure(cache: RunLogCache | null, companyId: string, message: string, now: number): RunLogCache {
  const base = cache && cache.companyId === companyId ? cache : emptyRunLogCache(companyId);
  return { ...base, inFlightUntil: 0, checkedAt: now, error: message };
}

function isWindow(w: unknown): w is LimitWindow | null {
  if (w === null) return true;
  if (!w || typeof w !== "object") return false;
  const x = w as LimitWindow;
  return (x.utilization === null || finite(x.utilization)) && (x.resetsAt === null || finite(x.resetsAt));
}

/** Parse a stored entry; null for a missing, foreign or malformed value. */
export function parseRunLogCache(raw: string | null): RunLogCache | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const c = value as Partial<RunLogCache>;
  if (c.v !== RUNLOG_CACHE_VERSION) return null;
  if (!finite(c.attemptAt) || !finite(c.inFlightUntil)) return null;
  if (c.checkedAt !== null && !finite(c.checkedAt)) return null;
  if (c.companyId !== null && typeof c.companyId !== "string") return null;
  if (c.error !== null && typeof c.error !== "string") return null;
  let snapshot: RateLimitSnapshot | null = null;
  const s = c.snapshot as RateLimitSnapshot | null | undefined;
  if (s && finite(s.at) && isWindow(s.fiveHour ?? null) && isWindow(s.sevenDay ?? null)) {
    snapshot = { at: s.at, status: s.status ?? null, fiveHour: s.fiveHour ?? null, sevenDay: s.sevenDay ?? null, runId: s.runId ?? null };
  }
  return {
    v: RUNLOG_CACHE_VERSION,
    companyId: c.companyId ?? null,
    attemptAt: c.attemptAt,
    inFlightUntil: c.inFlightUntil,
    checkedAt: c.checkedAt ?? null,
    snapshot,
    error: c.error ?? null,
  };
}
