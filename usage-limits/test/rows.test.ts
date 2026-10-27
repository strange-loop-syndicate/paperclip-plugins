import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPanels, type PanelInput, type ProviderQuotaResult } from "../src/mapping.ts";
import { compactDuration, hasKnownWindow, rowFromClaudeUsage, rowFromPanel, rowText, rowTitle, windowAt } from "../src/rows.ts";
import type { ClaudeUsage } from "../src/claude-usage.ts";

const CLAUDE = { slug: "anthropic", label: "Claude" };
const CODEX = { slug: "openai", label: "Codex" };
const NOW = Date.parse("2026-10-23T18:46:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

function usage(
  five: number | null,
  fiveReset: number | null,
  week: number | null,
  weekReset: number | null,
  asOf = NOW - 9 * MIN,
  extra: Partial<ClaudeUsage> = {},
): ClaudeUsage {
  return {
    fiveHour: five === null && fiveReset === null ? null : { utilization: five, resetsAt: fiveReset },
    sevenDay: week === null && weekReset === null ? null : { utilization: week, resetsAt: weekReset },
    asOf,
    account: "oleg@example.com",
    reason: null,
    ...extra,
  };
}

const claudeRow = (u: ClaudeUsage) => rowFromClaudeUsage(CLAUDE, u, NOW);

function quotaInput(results: ProviderQuotaResult[] | null, extra: Partial<PanelInput> = {}): PanelInput {
  return { results, fetchedAt: results ? NOW - MIN : null, fetchError: null, lastGood: {}, retryAt: null, ...extra };
}

test("row text: 5-hour %, weekly %, time to the 5-hour reset, one space apart", () => {
  const row = claudeRow(usage(10.4, NOW + 2 * HOUR + 14 * MIN, 83, NOW + 26 * HOUR));
  assert.equal(rowText(row, NOW), "10% 83% 2:14");
  const title = rowTitle(row, NOW);
  assert.match(title, /^Claude usage limits\nAccount: oleg@example.com\n5-hour window: 10% used, resets in 2h 14m \(/);
  assert.match(title, /\nWeekly window: 83% used, resets in 1d 2h \(/);
  assert.match(title, /\nSource: Anthropic usage API, as of \d\d:\d\d$/);
});

test("stale window: an event older than a window's reset makes it unknown, not 0%", () => {
  // Event from 6 h ago: its 5-hour window reset 1 h ago, the weekly one is still running.
  const row = claudeRow(usage(95, NOW - HOUR, 83, NOW + 26 * HOUR, NOW - 6 * HOUR));
  assert.deepEqual(row.fiveHour, { percent: null, resetsAt: NOW - HOUR, resetSince: true });
  assert.equal(rowText(row, NOW), "— 83% 1d2h", "next reset falls back to the weekly one");
  assert.match(rowTitle(row, NOW), /5-hour window: unknown \(reset at .*, after the latest data\)/);
  assert.doesNotMatch(rowText(row, NOW), /95|0%/);

  const allReset = claudeRow(usage(95, NOW - HOUR, 83, NOW));
  assert.equal(hasKnownWindow(allReset), false, "a reset at exactly now counts as reset");
  assert.equal(rowText(allReset, NOW), "—");
});

test("windowAt rounds and clamps; past reset clears the percent", () => {
  assert.deepEqual(windowAt(82.6, NOW + 1, NOW), { percent: 83, resetsAt: NOW + 1, resetSince: false });
  assert.deepEqual(windowAt(140, null, NOW), { percent: 100, resetsAt: null, resetSince: false });
  assert.deepEqual(windowAt(50, NOW, NOW), { percent: null, resetsAt: NOW, resetSince: true });
});

test("no data: icon + — with the reason in the title", () => {
  const reason = "No Claude credentials file (/x/.credentials.json); sign in with Claude Code";
  const row = claudeRow({ fiveHour: null, sevenDay: null, asOf: null, account: null, reason });
  assert.equal(rowText(row, NOW), "—");
  assert.equal(rowTitle(row, NOW), `Claude usage limits\nAccount: unknown\nNo data: ${reason}`);
});

test("Codex row from quota windows: a weekly '5h limit' counts as weekly, credits ignored", () => {
  const results: ProviderQuotaResult[] = [
    {
      provider: "openai",
      ok: true,
      windows: [
        { label: "5h limit", usedPercent: 3, resetsAt: new Date(NOW + 6 * 24 * HOUR).toISOString(), valueLabel: null },
        { label: "Credits", usedPercent: null, resetsAt: null, valueLabel: "$0.00 remaining" },
      ],
    },
  ];
  const [panel] = buildPanels([CODEX], quotaInput(results), new Date(NOW));
  const row = rowFromPanel(panel, NOW);
  assert.equal(row.fiveHour, null);
  assert.equal(row.weekly!.percent, 3);
  assert.equal(rowText(row, NOW), "— 3% 6d");
  assert.match(rowTitle(row, NOW), /5-hour window: no data\nWeekly window: 3% used/);
  assert.match(rowTitle(row, NOW), /Source: usage API, as of /);

  const both: ProviderQuotaResult[] = [
    {
      provider: "openai",
      ok: true,
      windows: [
        { label: "5h limit", usedPercent: 40, resetsAt: new Date(NOW + HOUR).toISOString(), valueLabel: null },
        { label: "Weekly limit", usedPercent: 12, resetsAt: new Date(NOW + 3 * 24 * HOUR).toISOString(), valueLabel: null },
      ],
    },
  ];
  const [panel2] = buildPanels([CODEX], quotaInput(both), new Date(NOW));
  assert.equal(rowText(rowFromPanel(panel2, NOW), NOW), "40% 12% 1:00");
});

test("a failing provider with no data: — and the short reason in the title", () => {
  const results: ProviderQuotaResult[] = [{ provider: "openai", ok: false, error: "chatgpt wham api returned 429", windows: [] }];
  const [panel] = buildPanels([CODEX], quotaInput(results, { retryAt: NOW + 10 * MIN }), new Date(NOW));
  const row = rowFromPanel(panel, NOW);
  assert.equal(rowText(row, NOW), "—");
  assert.equal(rowTitle(row, NOW), "Codex usage limits\nNo data: Rate-limited by OpenAI, retrying in 10m");
});

test("a reading kept after a failed refresh shows its time and the reason", () => {
  const row = claudeRow(usage(10, NOW + HOUR, 80, NOW + 24 * HOUR, NOW - 7 * MIN, { reason: "Usage API throttled (429)" }));
  assert.equal(rowText(row, NOW), "10% 80% 1:00");
  const title = rowTitle(row, NOW);
  assert.match(title, /\nSource: Anthropic usage API, as of \d\d:\d\d\nNote: Usage API throttled \(429\)$/);
});

test("a reading without a time is not shown as data", () => {
  const row = claudeRow(usage(10, NOW + HOUR, 80, NOW + 24 * HOUR, NOW, { asOf: null, reason: "Usage API returned 500" }));
  assert.equal(rowText(row, NOW), "—");
  assert.match(rowTitle(row, NOW), /No data: Usage API returned 500$/);
});

test("compact reset: H:MM under 24 h, compact days from 24 h", () => {
  assert.equal(compactDuration(0), "0:00");
  assert.equal(compactDuration(-MIN), "0:00");
  assert.equal(compactDuration(5 * MIN), "0:05");
  assert.equal(compactDuration(4 * MIN + 1), "0:05", "rounds up to the next minute");
  assert.equal(compactDuration(2 * HOUR + 30 * MIN), "2:30");
  assert.equal(compactDuration(23 * HOUR + 59 * MIN), "23:59");
  assert.equal(compactDuration(23 * HOUR + 59 * MIN + 1), "1d", "a value rounded up to 24 h is a day");
  assert.equal(compactDuration(24 * HOUR), "1d");
  assert.equal(compactDuration(3 * 24 * HOUR + 4 * HOUR + 59 * MIN), "3d4h");
  assert.equal(compactDuration(6 * 24 * HOUR), "6d");
});

test("row text: the board's example, and unknown parts", () => {
  const row = claudeRow(usage(14, NOW + 2 * HOUR + 30 * MIN, 84, NOW + 3 * 24 * HOUR));
  assert.equal(rowText(row, NOW), "14% 84% 2:30");
  assert.doesNotMatch(rowText(row, NOW), /\/|  /);
  const noReset = claudeRow(usage(14, null, 84, null));
  assert.equal(rowText(noReset, NOW), "14% 84% —");
  const fiveHourOnly = claudeRow(usage(7, NOW + 5 * MIN, null, null));
  assert.equal(rowText(fiveHourOnly, NOW), "7% — 0:05");
});

test("account line: the email when known, 'unknown' when not; none for Codex", () => {
  const known = rowTitle(claudeRow(usage(10, NOW + HOUR, 80, NOW + 24 * HOUR)), NOW);
  assert.equal(known.split("\n")[1], "Account: oleg@example.com");
  const unknown = rowTitle(claudeRow(usage(10, NOW + HOUR, 80, NOW + 24 * HOUR, NOW - MIN, { account: null })), NOW);
  assert.equal(unknown.split("\n")[1], "Account: unknown");
  assert.match(unknown, /\n5-hour window: 10% used/, "numbers still shown");

  const [panel] = buildPanels(
    [CODEX],
    quotaInput([{ provider: "openai", ok: true, windows: [{ label: "5h limit", usedPercent: 3, resetsAt: null, valueLabel: null }] }]),
    new Date(NOW),
  );
  assert.doesNotMatch(rowTitle(rowFromPanel(panel, NOW), NOW), /Account:/);
});
