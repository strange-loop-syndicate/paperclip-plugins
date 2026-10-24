import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyScan,
  applyScanFailure,
  markScanStarted,
  newestSnapshot,
  parseRunLog,
  parseRunLogCache,
  RUNLOG_INTERVAL_MS,
  scanCandidates,
  scanDue,
  scanRuns,
  snapshotFromInfo,
  type RunSummary,
} from "../src/runlog.ts";

const COMPANY = "c1";
const T0 = Date.parse("2026-10-23T18:37:24.669Z");

/** A rate_limit_info object as Claude Code 2.x emits it. */
function info(five: number, week: number, fiveReset = 1792795200, weekReset = 1792832400) {
  return {
    status: "allowed_warning",
    resetsAt: weekReset,
    rateLimitType: "seven_day",
    utilization: week,
    overageStatus: "rejected",
    isUsingOverage: false,
    surpassedThreshold: 0.75,
    unifiedWindows: {
      five_hour: { utilization: five, resetsAt: fiveReset },
      seven_day: { utilization: week, resetsAt: weekReset },
    },
  };
}

function streamLine(obj: unknown): string {
  return JSON.stringify(obj);
}

/** One run-log NDJSON line: the stream-json text sits escaped inside `chunk`. */
function logLine(ts: number, chunk: string, seq: number, stream = "stdout"): string {
  return JSON.stringify({ ts: new Date(ts).toISOString(), attemptId: "a", stream, chunk, seq });
}

function eventChunk(five: number, week: number): string {
  return streamLine({ type: "rate_limit_event", rate_limit_info: info(five, week), uuid: "u", session_id: "s" }) + "\n";
}

test("parses an escaped rate_limit_event inside a log chunk (real log line)", () => {
  // Verbatim from a claude_local run log on the lab instance.
  const real =
    '{"ts":"2026-10-23T18:37:24.669Z","attemptId":"f2760b6c-382a-40a1-be14-7eae658cf9e8","stream":"stdout","chunk":"{\\"type\\":\\"rate_limit_event\\",\\"rate_limit_info\\":{\\"status\\":\\"allowed_warning\\",\\"resetsAt\\":1792832400,\\"rateLimitType\\":\\"seven_day\\",\\"utilization\\":0.83,\\"overageStatus\\":\\"rejected\\",\\"overageDisabledReason\\":\\"out_of_credits\\",\\"isUsingOverage\\":false,\\"surpassedThreshold\\":0.75,\\"unifiedWindows\\":{\\"five_hour\\":{\\"utilization\\":0.1,\\"resetsAt\\":1792795200},\\"seven_day\\":{\\"utilization\\":0.83,\\"resetsAt\\":1792832400}},\\"overageEnabled\\":true},\\"uuid\\":\\"7bb99965-abba-47fa-9eef-adea9a74bbd7\\",\\"session_id\\":\\"2dc0d042-32f9-461a-ad3f-84167fb00d41\\"}\\n","seq":352}\n';
  const [snap, ...rest] = parseRunLog(real, { fromStart: true, runId: "r1" });
  assert.equal(rest.length, 0);
  assert.equal(snap.at, T0);
  assert.equal(snap.status, "allowed_warning");
  assert.equal(snap.runId, "r1");
  assert.equal(Math.round(snap.fiveHour!.utilization!), 10);
  assert.equal(snap.fiveHour!.resetsAt, 1792795200_000);
  assert.equal(Math.round(snap.sevenDay!.utilization!), 83);
  assert.equal(snap.sevenDay!.resetsAt, 1792832400_000);
});

test("finds the event among other stream lines in the same chunk", () => {
  const chunk =
    streamLine({ type: "assistant", message: { content: [{ type: "text", text: "rate_limit_event is a word here" }] } }) +
    "\n" +
    eventChunk(0.2, 0.5) +
    streamLine({ type: "user" }) +
    "\n";
  const snaps = parseRunLog(logLine(T0, chunk, 1) + "\n", { fromStart: true });
  assert.equal(snaps.length, 1);
  assert.equal(Math.round(snaps[0].fiveHour!.utilization!), 20);
});

test("an event split across two chunks is joined; its time is the completing line's", () => {
  const full = eventChunk(0.3, 0.6);
  const cut = 40;
  const text = [logLine(T0, full.slice(0, cut), 1), logLine(T0 + 5, full.slice(cut), 2)].join("\n") + "\n";
  const snaps = parseRunLog(text, { fromStart: true });
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].at, T0 + 5);
});

test("a tail read skips the partial first line and a cut-off last line; stderr is ignored", () => {
  const good = logLine(T0, eventChunk(0.1, 0.4), 2);
  const text =
    "tail of an earlier line\"}\n" +
    logLine(T0 - 10, eventChunk(0.9, 0.9), 1, "stderr") +
    "\n" +
    good +
    "\n" +
    good.slice(0, 50);
  const snaps = parseRunLog(text, { fromStart: false });
  assert.equal(snaps.length, 1);
  assert.equal(Math.round(snaps[0].fiveHour!.utilization!), 10);
});

test("multiple events: the newest by log time wins", () => {
  const text = [
    logLine(T0, eventChunk(0.1, 0.8), 1),
    logLine(T0 + 60_000, eventChunk(0.15, 0.81), 2),
    logLine(T0 + 30_000, eventChunk(0.12, 0.8), 3),
  ].join("\n");
  const snaps = parseRunLog(text, { fromStart: true });
  assert.equal(snaps.length, 3);
  const newest = newestSnapshot(snaps)!;
  assert.equal(newest.at, T0 + 60_000);
  assert.equal(Math.round(newest.fiveHour!.utilization!), 15);
  assert.equal(newestSnapshot([]), null);
});

test("older events without unifiedWindows fill only the named window", () => {
  const snap = snapshotFromInfo({ status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: 1792795200 }, T0)!;
  assert.equal(Math.round(snap.fiveHour!.utilization!), 42);
  assert.equal(snap.sevenDay, null);
  assert.equal(snapshotFromInfo({ status: "allowed" }, T0), null);
  assert.equal(snapshotFromInfo(null, T0), null);
});

function run(id: string, agentId: string, extra: Partial<RunSummary> = {}): RunSummary {
  return { id, agentId, status: "succeeded", createdAt: "2026-10-23T10:00:00.000Z", ...extra };
}

test("scanCandidates keeps the given agents' runs, newest activity first, bounded", () => {
  const runs = [
    run("old", "claude", { finishedAt: "2026-10-23T11:00:00.000Z" }),
    run("codex", "codex", { finishedAt: "2026-10-23T15:00:00.000Z" }),
    run("live", "claude", { status: "running", lastOutputAt: "2026-10-23T14:00:00.000Z" }),
    run("queued", "claude", { status: "queued", createdAt: "2026-10-23T16:00:00.000Z" }),
    run("gz", "claude", { logCompressed: true, finishedAt: "2026-10-23T16:00:00.000Z" }),
    run("mid", "claude", { finishedAt: "2026-10-23T12:00:00.000Z" }),
  ];
  assert.deepEqual(scanCandidates(runs, ["claude"]).map((r) => r.id), ["live", "mid", "old"]);
  assert.deepEqual(scanCandidates(runs, ["claude"], 2).map((r) => r.id), ["live", "mid"]);
});

test("scanRuns reads tails only, falls back to the head, and stops once older runs cannot be newer", async () => {
  const at = (iso: string) => Date.parse(iso);
  // Run A (finished 12:00): event at 11:50 in its tail. Run B (finished 11:00): never needs reading.
  const logs: Record<string, string> = {
    A: "x".repeat(100) + "\n" + logLine(at("2026-10-23T11:50:00Z"), eventChunk(0.2, 0.7), 9) + "\n",
    B: logLine(at("2026-10-23T10:59:00Z"), eventChunk(0.9, 0.9), 1) + "\n",
  };
  const reads: Array<[string, number, number]> = [];
  const readLog = async (id: string, offset: number, limit: number) => {
    reads.push([id, offset, limit]);
    return logs[id].slice(offset, offset + limit);
  };
  const runs = [
    run("A", "claude", { finishedAt: "2026-10-23T12:00:00.000Z", logBytes: logs.A.length }),
    run("B", "claude", { finishedAt: "2026-10-23T11:00:00.000Z", logBytes: logs.B.length }),
  ];
  const result = await scanRuns(runs, ["claude"], readLog, { tailBytes: logs.A.length - 50, headBytes: 64 });
  assert.equal(result.snapshot!.at, at("2026-10-23T11:50:00Z"));
  assert.deepEqual(reads, [["A", 50, logs.A.length - 50]], "one tail read, run B skipped");

  // A running run has no size: its head is read, and the older finished run is still checked.
  reads.length = 0;
  const live = logLine(at("2026-10-23T09:00:00Z"), eventChunk(0.05, 0.6), 1) + "\n" + "y".repeat(500);
  logs.L = live;
  const result2 = await scanRuns(
    [run("L", "claude", { status: "running", startedAt: "2026-10-23T09:00:00.000Z", lastOutputAt: "2026-10-23T13:00:00.000Z" }), ...runs],
    ["claude"],
    readLog,
    { tailBytes: 1_000_000, headBytes: 2_000 },
  );
  assert.deepEqual(reads.map((r) => [r[0], r[1]]), [["L", 0], ["A", 0]], "small finished log read whole from 0");
  assert.equal(result2.snapshot!.at, at("2026-10-23T11:50:00Z"), "the finished run's later event wins");
});

test("scanRuns keeps going past a failing log and reports it", async () => {
  const good = logLine(T0, eventChunk(0.1, 0.2), 1) + "\n";
  const result = await scanRuns(
    [
      run("bad-run-id", "claude", { finishedAt: "2026-10-23T19:00:00.000Z", logBytes: 10 }),
      run("ok", "claude", { finishedAt: "2026-10-23T18:40:00.000Z", logBytes: good.length }),
    ],
    ["claude"],
    async (id) => {
      if (id === "bad-run-id") throw new Error("403 Forbidden");
      return good;
    },
  );
  assert.equal(result.snapshot!.at, T0);
  assert.deepEqual(result.errors, ["run bad-run-: 403 Forbidden"]);
});

test("run-log cache: due every 2 min, waits for another tab, keeps the newer snapshot", () => {
  const now = 1_000_000_000;
  assert.equal(scanDue(null, COMPANY, now), true);
  const started = markScanStarted(null, COMPANY, now);
  assert.equal(scanDue(started, COMPANY, now + 1_000), false, "in flight in another tab");
  assert.equal(scanDue(started, "other-company", now + 1_000), true, "company switch scans at once");

  const newer = { at: now - 1_000, status: "allowed", fiveHour: { utilization: 10, resetsAt: now + 3_600_000 }, sevenDay: null };
  const done = applyScan(started, COMPANY, { snapshot: newer, reads: 1, runsRead: 1, errors: [] }, now + 2_000);
  assert.equal(done.error, null);
  assert.equal(scanDue(done, COMPANY, now + RUNLOG_INTERVAL_MS - 1), false);
  assert.equal(scanDue(done, COMPANY, now + RUNLOG_INTERVAL_MS), true);

  const older = { ...newer, at: now - 9_000, fiveHour: { utilization: 99, resetsAt: now + 3_600_000 } };
  const again = applyScan(done, COMPANY, { snapshot: older, reads: 1, runsRead: 1, errors: [] }, now + 200_000);
  assert.equal(again.snapshot!.fiveHour!.utilization, 10, "an older event never replaces a newer one");

  const empty = applyScan(done, COMPANY, { snapshot: null, reads: 2, runsRead: 2, errors: [] }, now + 300_000);
  assert.equal(empty.snapshot!.at, newer.at);
  assert.match(empty.error!, /No rate_limit_event/);

  const failed = applyScanFailure(done, COMPANY, "Run list request failed (403)", now + 400_000);
  assert.equal(failed.snapshot!.at, newer.at);
  assert.equal(failed.error, "Run list request failed (403)");

  assert.deepEqual(parseRunLogCache(JSON.stringify(failed)), { ...failed, snapshot: { ...failed.snapshot!, runId: null } });
  assert.equal(parseRunLogCache("{"), null);
  assert.equal(parseRunLogCache(JSON.stringify({ ...failed, v: 99 })), null);
});
