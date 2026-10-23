import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPanels,
  formatResetIn,
  normalizePercent,
  severityFor,
  usedProviders,
  type ProviderQuotaResult,
} from "../src/mapping.ts";

const NOW = new Date("2026-10-23T12:00:00.000Z");
const CLAUDE = { slug: "anthropic", label: "Claude" };
const CODEX = { slug: "openai", label: "Codex" };

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
  const panels = buildPanels([CLAUDE], results, null, NOW);
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
});

test("buildPanels marks provider errors and missing providers unavailable", () => {
  const results: ProviderQuotaResult[] = [
    { provider: "anthropic", ok: false, error: "quota polling timed out after 20s", windows: [] },
  ];
  const [claude, codex] = buildPanels([CLAUDE, CODEX], results, null, NOW);
  assert.equal(claude.state, "unavailable");
  assert.equal(claude.message, "quota polling timed out after 20s");
  assert.equal(codex.state, "unavailable");
  assert.equal(codex.message, "Provider reported no quota data");
});

test("buildPanels falls back to errorFamily, then a generic message", () => {
  const [a] = buildPanels([CLAUDE], [{ provider: "anthropic", ok: false, errorFamily: "auth", windows: [] }], null, NOW);
  assert.equal(a.message, "auth");
  const [b] = buildPanels([CLAUDE], [{ provider: "anthropic", ok: false, windows: [] }], null, NOW);
  assert.equal(b.message, "Quota lookup failed");
});

test("buildPanels prefers an ok result over a failed duplicate", () => {
  const [claude] = buildPanels(
    [CLAUDE],
    [
      { provider: "anthropic", ok: false, error: "cli failed", windows: [] },
      { provider: "anthropic", ok: true, windows: [{ label: "5h", usedPercent: 10, resetsAt: null, valueLabel: null }] },
    ],
    null,
    NOW,
  );
  assert.equal(claude.state, "ok");
  assert.equal(claude.windows[0].usedPercent, 10);
});

test("buildPanels shows empty state when ok but no windows (e.g. bedrock)", () => {
  const [claude] = buildPanels([CLAUDE], [{ provider: "anthropic", source: "bedrock", ok: true, windows: [] }], null, NOW);
  assert.equal(claude.state, "empty");
  assert.equal(claude.message, "No quota windows reported");
});

test("buildPanels marks every provider unavailable on a fetch error, shortened", () => {
  const long = "x".repeat(400);
  const panels = buildPanels([CLAUDE, CODEX], null, long, NOW);
  assert.deepEqual(panels.map((p) => p.state), ["unavailable", "unavailable"]);
  assert.equal(panels[0].message?.length, 160);
  assert.ok(panels[0].message?.endsWith("…"));
  const [notLoaded] = buildPanels([CLAUDE], null, null, NOW);
  assert.equal(notLoaded.message, "Quota data not loaded");
});

test("credit-style window without a percent keeps its value label", () => {
  const [codex] = buildPanels(
    [CODEX],
    [{ provider: "openai", ok: true, windows: [{ label: "Credits", usedPercent: null, resetsAt: null, valueLabel: "$4.20 remaining" }] }],
    null,
    NOW,
  );
  assert.equal(codex.windows[0].severity, "unknown");
  assert.equal(codex.windows[0].valueLabel, "$4.20 remaining");
  assert.equal(codex.windows[0].resetIn, null);
});
