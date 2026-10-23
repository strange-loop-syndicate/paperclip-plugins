import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPanels,
  compactItem,
  formatClock,
  formatDuration,
  formatResetIn,
  isZeroCreditRow,
  normalizePercent,
  relabelWindow,
  severityFor,
  shortError,
  toWindowRow,
  tooltipText,
  usedProviders,
  type PanelInput,
  type ProviderQuotaResult,
} from "../src/mapping.ts";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const CLAUDE = { slug: "anthropic", label: "Claude" };
const CODEX = { slug: "openai", label: "Codex" };
const FETCHED = NOW.getTime() - 60_000;

function input(results: ProviderQuotaResult[] | null, extra: Partial<PanelInput> = {}): PanelInput {
  return { results, fetchedAt: results ? FETCHED : null, fetchError: null, lastGood: {}, retryAt: null, ...extra };
}

test("usedProviders keeps only claude_local/codex_local, skips terminated, stable order", () => {
  const providers = usedProviders([
    { adapterType: "codex_local", status: "idle" },
    { adapterType: "process", status: "idle" },
    { adapterType: "claude_local", status: "running" },
    { adapterType: "claude_local", status: "paused" },
    { adapterType: "gemini_local", status: "idle" },
  ]);
  assert.deepEqual(providers, [CLAUDE, CODEX]);
});

test("usedProviders ignores a provider whose only agent is terminated", () => {
  assert.deepEqual(
    usedProviders([
      { adapterType: "codex_local", status: "terminated" },
      { adapterType: "claude_local", status: "idle" },
    ]),
    [CLAUDE],
  );
  assert.deepEqual(usedProviders([]), []);
  assert.deepEqual(usedProviders([{ adapterType: null }]), []);
});

test("formatResetIn covers minutes, hours, days, past and invalid", () => {
  assert.equal(formatResetIn("2026-10-23T12:42:00.000Z", NOW), "in 42m");
  assert.equal(formatResetIn("2026-10-23T15:05:00.000Z", NOW), "in 3h 05m");
  assert.equal(formatResetIn("2026-10-25T16:00:00.000Z", NOW), "in 2d 4h");
  assert.equal(formatResetIn("2026-10-30T12:00:00.000Z", NOW), "in 7d");
  assert.equal(formatResetIn("2026-10-23T11:00:00.000Z", NOW), "now");
  assert.equal(formatResetIn("not a date", NOW), null);
  assert.equal(formatResetIn(null, NOW), null);
});

test("normalizePercent clamps and rounds; severity thresholds", () => {
  assert.equal(normalizePercent(42.6), 43);
  assert.equal(normalizePercent(130), 100);
  assert.equal(normalizePercent(-5), 0);
  assert.equal(normalizePercent(null), null);
  assert.equal(normalizePercent(Number.NaN), null);
  assert.equal(severityFor(null), "unknown");
  assert.equal(severityFor(74), "ok");
  assert.equal(severityFor(75), "warn");
  assert.equal(severityFor(90), "critical");
});

test("buildPanels maps ok windows per used provider only", () => {
  const results: ProviderQuotaResult[] = [
    {
      provider: "anthropic",
      source: "anthropic-oauth",
      ok: true,
      windows: [
        { label: "5h", usedPercent: 37.4, resetsAt: "2026-10-23T14:30:00.000Z", valueLabel: null },
        { label: "7d", usedPercent: 91, resetsAt: "2026-10-27T12:00:00.000Z", valueLabel: null, detail: "all models" },
      ],
    },
    { provider: "openai", ok: true, windows: [{ label: "5h", usedPercent: 5, resetsAt: null, valueLabel: null }] },
  ];
  const panels = buildPanels([CLAUDE], input(results), NOW);
  assert.equal(panels.length, 1, "codex is not used, so it must not appear");
  const [claude] = panels;
  assert.equal(claude.state, "ok");
  assert.equal(claude.message, null);
  assert.deepEqual(
    claude.windows.map((w) => [w.label, w.usedPercent, w.severity, w.resetIn, w.detail]),
    [
      ["5h", 37, "ok", "in 2h 30m", null],
      ["7d", 91, "critical", "in 4d", "all models"],
    ],
  );
  assert.equal(claude.asOf, FETCHED);
});

test("buildPanels marks provider errors and missing providers unavailable", () => {
  const results: ProviderQuotaResult[] = [
    { provider: "anthropic", ok: false, error: "quota polling timed out after 20s", windows: [] },
  ];
  const [claude, codex] = buildPanels([CLAUDE, CODEX], input(results), NOW);
  assert.equal(claude.state, "unavailable");
  assert.equal(claude.message, "Timed out");
  assert.equal(claude.errorDetail, "quota polling timed out after 20s");
  assert.equal(codex.state, "unavailable");
  assert.equal(codex.message, "No quota data");
  assert.equal(codex.errorDetail, "Provider reported no quota data");
});

test("buildPanels falls back to errorFamily, then a generic message", () => {
  const [a] = buildPanels([CLAUDE], input([{ provider: "anthropic", ok: false, errorFamily: "auth", windows: [] }]), NOW);
  assert.equal(a.message, "Auth failed");
  assert.equal(a.errorDetail, "auth");
  const [b] = buildPanels([CLAUDE], input([{ provider: "anthropic", ok: false, windows: [] }]), NOW);
  assert.equal(b.message, "Lookup failed");
  assert.equal(b.errorDetail, "Quota lookup failed");
});

test("buildPanels prefers an ok result over a failed duplicate", () => {
  const [claude] = buildPanels(
    [CLAUDE],
    input([
      { provider: "anthropic", ok: false, error: "cli failed", windows: [] },
      { provider: "anthropic", ok: true, windows: [{ label: "5h", usedPercent: 10, resetsAt: null, valueLabel: null }] },
    ]),
    NOW,
  );
  assert.equal(claude.state, "ok");
  assert.equal(claude.windows[0].usedPercent, 10);
});

test("buildPanels shows empty state when ok but no windows (e.g. bedrock)", () => {
  const [claude] = buildPanels([CLAUDE], input([{ provider: "anthropic", source: "bedrock", ok: true, windows: [] }]), NOW);
  assert.equal(claude.state, "empty");
  assert.equal(claude.message, "No quota windows reported");
});

test("buildPanels: a failed request with no older data is unavailable, full text kept for the tooltip", () => {
  const long = `Quota request failed (502 Bad Gateway: ${"x".repeat(400)})`;
  const panels = buildPanels([CLAUDE, CODEX], input(null, { fetchError: long }), NOW);
  assert.deepEqual(panels.map((p) => p.state), ["unavailable", "unavailable"]);
  assert.equal(panels[0].message, "Usage request failed");
  assert.equal(panels[0].errorDetail, long);
  const [notLoaded] = buildPanels([CLAUDE], input(null), NOW);
  assert.equal(notLoaded.message, "No quota data");
});

test("credit-style window without a percent keeps its value label", () => {
  const [codex] = buildPanels(
    [CODEX],
    input([{ provider: "openai", ok: true, windows: [{ label: "Credits", usedPercent: null, resetsAt: null, valueLabel: "$4.20 remaining" }] }]),
    NOW,
  );
  assert.equal(codex.windows[0].severity, "unknown");
  assert.equal(codex.windows[0].valueLabel, "$4.20 remaining");
  assert.equal(codex.windows[0].resetIn, null);
});

const CLAUDE_429 =
  "Claude subscription session found, but quota polling failed (Anthropic OAuth usage: anthropic usage api returned 429; Claude CLI /usage: exited with code 1)";

test("buildPanels keeps last good windows as stale when the provider now fails", () => {
  const asOf = NOW.getTime() - 25 * 60_000;
  const lastGood = {
    anthropic: { windows: [{ label: "Current session", usedPercent: 82, resetsAt: "2026-10-23T14:00:00.000Z", valueLabel: null }], fetchedAt: asOf },
  };
  const retry = NOW.getTime() + 10 * 60_000;
  const results: ProviderQuotaResult[] = [
    { provider: "anthropic", ok: false, error: CLAUDE_429, windows: [] },
    { provider: "openai", ok: true, windows: [{ label: "Weekly limit", usedPercent: 3, resetsAt: null, valueLabel: null }] },
  ];
  const [claude, codex] = buildPanels([CLAUDE, CODEX], input(results, { lastGood, retryAt: retry }), NOW);
  assert.equal(claude.state, "stale");
  assert.equal(claude.asOf, asOf);
  assert.equal(claude.message, "Rate-limited by Anthropic, retrying in 10m");
  assert.equal(claude.errorDetail, CLAUDE_429);
  assert.deepEqual(claude.windows.map((w) => [w.label, w.usedPercent]), [["Current session", 82]]);
  assert.equal(codex.state, "ok");
});

test("buildPanels keeps last good windows as stale when the whole request fails", () => {
  const lastGood = { openai: { windows: [{ label: "5h limit", usedPercent: 40, resetsAt: null, valueLabel: null }], fetchedAt: FETCHED } };
  const [claude, codex] = buildPanels([CLAUDE, CODEX], input(null, { fetchError: "Failed to fetch", lastGood }), NOW);
  assert.equal(claude.state, "unavailable");
  assert.equal(codex.state, "stale");
  assert.equal(codex.message, "Usage request failed");
});

test("shortError: rate limit, timeout, auth, generic; retry hint only while waiting", () => {
  const retry = NOW.getTime() + 10 * 60_000;
  assert.equal(shortError("anthropic", CLAUDE_429, retry, NOW), "Rate-limited by Anthropic, retrying in 10m");
  assert.equal(shortError("openai", "429 Too Many Requests", null, NOW), "Rate-limited by OpenAI");
  assert.equal(shortError(null, "Quota request failed (429 Too Many Requests)", retry, NOW), "Rate-limited, retrying in 10m");
  assert.equal(shortError("openai", "quota polling timed out after 20s", null, NOW), "Timed out");
  assert.equal(shortError("openai", "chatgpt wham api returned 401", null, NOW), "Auth failed");
  assert.equal(shortError("openai", "boom", NOW.getTime() - 1, NOW), "Lookup failed");
});

test("relabelWindow: a 5h label that resets days away becomes Weekly limit", () => {
  // The owner's case: Codex primary_window "5h limit, resets in 6d 23h".
  assert.equal(relabelWindow("5h limit", "2026-10-30T11:00:00.000Z", NOW), "Weekly limit");
  assert.equal(relabelWindow("GPT-5.3 · 5h limit", "2026-10-30T11:00:00.000Z", NOW), "GPT-5.3 · Weekly limit");
  assert.equal(relabelWindow("5h", "2026-10-25T12:00:00.000Z", NOW), "Weekly limit");
});

test("relabelWindow leaves consistent, unknown and non-5h labels alone", () => {
  assert.equal(relabelWindow("5h limit", "2026-10-23T16:30:00.000Z", NOW), "5h limit", "4.5h away is a real 5h window");
  assert.equal(relabelWindow("5h limit", "2026-10-23T17:04:00.000Z", NOW), "5h limit", "within the 5 min skew allowance");
  assert.equal(relabelWindow("5h limit", null, NOW), "5h limit");
  assert.equal(relabelWindow("5h limit", "garbage", NOW), "5h limit");
  assert.equal(relabelWindow("Weekly limit", "2026-10-30T11:00:00.000Z", NOW), "Weekly limit");
  assert.equal(relabelWindow("Current week (all models)", "2026-10-30T11:00:00.000Z", NOW), "Current week (all models)");
  assert.equal(relabelWindow("GPT-5 high", "2026-10-30T11:00:00.000Z", NOW), "GPT-5 high");
});

test("toWindowRow applies the relabel", () => {
  const row = toWindowRow({ label: "5h limit", usedPercent: 0, resetsAt: "2026-10-30T11:00:00.000Z", valueLabel: null }, NOW);
  assert.equal(row.label, "Weekly limit");
  assert.equal(row.resetIn, "in 6d 23h");
});

test("a $0 credits row next to percent windows moves to the tooltip", () => {
  const results: ProviderQuotaResult[] = [
    {
      provider: "openai",
      ok: true,
      windows: [
        { label: "5h limit", usedPercent: 0, resetsAt: "2026-10-30T11:00:00.000Z", valueLabel: null },
        { label: "Credits", usedPercent: null, resetsAt: null, valueLabel: "$0.00 remaining" },
      ],
    },
  ];
  const [codex] = buildPanels([CODEX], input(results), NOW);
  assert.deepEqual(codex.windows.map((w) => w.label), ["Weekly limit"]);
  assert.deepEqual(codex.tooltipOnly.map((w) => w.valueLabel), ["$0.00 remaining"]);
  assert.match(tooltipText([codex]), /Credits: \$0\.00 remaining/);
});

test("isZeroCreditRow keeps real balances and credits-only accounts visible", () => {
  const pct = toWindowRow({ label: "5h limit", usedPercent: 10, resetsAt: null, valueLabel: null }, NOW);
  const credit = (v: string) => toWindowRow({ label: "Credits", usedPercent: null, resetsAt: null, valueLabel: v }, NOW);
  assert.equal(isZeroCreditRow(credit("$0.00 remaining"), [pct]), true);
  assert.equal(isZeroCreditRow(credit("$0 remaining"), [pct]), true);
  assert.equal(isZeroCreditRow(credit("$0.50 remaining"), [pct]), false);
  assert.equal(isZeroCreditRow(credit("$0.05 remaining"), [pct]), false);
  assert.equal(isZeroCreditRow(credit("$4.20 remaining"), [pct]), false);
  assert.equal(isZeroCreditRow(credit("N/A"), [pct]), false);
  const alone = credit("$0.00 remaining");
  assert.equal(isZeroCreditRow(alone, [alone]), false, "no subscription windows: keep it");
});

test("compactItem picks the highest-used window and tags stale / rate-limited states", () => {
  const ok = buildPanels(
    [CLAUDE],
    input([
      {
        provider: "anthropic",
        ok: true,
        windows: [
          { label: "Current session", usedPercent: 82, resetsAt: null, valueLabel: null },
          { label: "Current week (all models)", usedPercent: 40, resetsAt: null, valueLabel: null },
          { label: "Extra usage", usedPercent: null, resetsAt: null, valueLabel: "Not enabled" },
        ],
      },
    ]),
    NOW,
  )[0];
  assert.deepEqual(compactItem(ok, { retryAt: null }, NOW), {
    slug: "anthropic",
    label: "Claude",
    percent: 82,
    severity: "warn",
    state: "ok",
    tag: null,
  });

  const retry = NOW.getTime() + 10 * 60_000;
  const failing = input([{ provider: "anthropic", ok: false, error: CLAUDE_429, windows: [] }], { retryAt: retry });
  const limited = buildPanels([CLAUDE], failing, NOW)[0];
  assert.deepEqual(
    [compactItem(limited, failing, NOW).percent, compactItem(limited, failing, NOW).tag],
    [null, "retry 10m"],
  );

  const lastGood = { anthropic: { windows: [{ label: "Current session", usedPercent: 95, resetsAt: null, valueLabel: null }], fetchedAt: FETCHED } };
  const stale = buildPanels([CLAUDE], { ...failing, lastGood }, NOW)[0];
  const item = compactItem(stale, failing, NOW);
  assert.deepEqual([item.percent, item.severity, item.state, item.tag], [95, "critical", "stale", "stale"]);
});

test("tooltipText lists every window with resets, the stale marker and the full error", () => {
  const asOf = new Date(2026, 9, 23, 14, 5).getTime();
  const lastGood = {
    anthropic: { windows: [{ label: "Current session", usedPercent: 82, resetsAt: "2026-10-23T14:00:00.000Z", valueLabel: null }], fetchedAt: asOf },
  };
  const panels = buildPanels(
    [CLAUDE],
    input([{ provider: "anthropic", ok: false, error: CLAUDE_429, windows: [] }], { lastGood, retryAt: NOW.getTime() + 600_000 }),
    NOW,
  );
  const text = tooltipText(panels);
  assert.match(text, /^Claude \(stale, as of 14:05\)/);
  assert.match(text, /Current session: 82% · resets in 2h 00m/);
  assert.match(text, /Rate-limited by Anthropic, retrying in 10m/);
  assert.ok(text.includes(`Error: ${CLAUDE_429}`));
});

test("formatDuration and formatClock", () => {
  assert.equal(formatDuration(10 * 60_000), "10m");
  assert.equal(formatDuration(65 * 60_000), "1h 05m");
  assert.equal(formatDuration(-5), "0m");
  assert.equal(formatClock(new Date(2026, 9, 23, 9, 7).getTime()), "09:07");
});
