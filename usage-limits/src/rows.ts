// One sidebar row per used provider: "10% 83% 2:14" = 5-hour used,
// weekly used, time to the next reset. Pure, so `node --test` can load it.

import type { ClaudeUsage } from "./claude-usage.ts";
import { formatAsOf, formatDuration, type ProviderInfo, type ProviderPanel } from "./mapping.ts";

export interface UsageWindow {
  /** Percent used, 0-100 rounded; null when unknown. */
  percent: number | null;
  /** Reset time (ms epoch); null when unknown. */
  resetsAt: number | null;
  /** The window reset after the data was read, so its old percent is no longer known. */
  resetSince: boolean;
}

export type RowSource = "claude-usage-api" | "quota-windows";

export interface UsageRow {
  slug: string;
  label: string;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  /** When the data was read (ms epoch); null when there is none. */
  asOf: number | null;
  source: RowSource | null;
  /** Signed-in account, when the source names it (Claude). */
  account?: string | null;
  /** Why the data is missing or old; for the hover title only. */
  reason: string | null;
}

function parseIso(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A window as of `now`. Once its reset time has passed, the reported percent
 * describes an old window: the value becomes unknown, not 0%.
 */
export function windowAt(percent: number | null, resetsAt: number | null, now: number): UsageWindow {
  const rounded = percent === null || !Number.isFinite(percent) ? null : Math.round(Math.min(100, Math.max(0, percent)));
  if (resetsAt !== null && resetsAt <= now) return { percent: null, resetsAt, resetSince: true };
  return { percent: rounded, resetsAt, resetSince: false };
}

export function hasKnownWindow(row: UsageRow | null | undefined): boolean {
  return Boolean(row && (row.fiveHour?.percent != null || row.weekly?.percent != null));
}

/**
 * Claude row from the worker's usage-API reading. A reading kept after a
 * failed refresh keeps its percent (with the reason) until its window resets.
 */
export function rowFromClaudeUsage(info: ProviderInfo, usage: ClaudeUsage, now: number): UsageRow {
  const win = (w: ClaudeUsage["fiveHour"]) => (w ? windowAt(w.utilization, w.resetsAt, now) : null);
  const known = usage.asOf !== null && Boolean(usage.fiveHour || usage.sevenDay);
  return {
    slug: info.slug,
    label: info.label,
    fiveHour: known ? win(usage.fiveHour) : null,
    weekly: known ? win(usage.sevenDay) : null,
    asOf: known ? usage.asOf : null,
    source: known ? "claude-usage-api" : null,
    account: usage.account,
    reason: usage.reason,
  };
}

const FIVE_HOUR_LABEL = /\b5\s*h\b|session/i;
const WEEKLY_LABEL = /week/i;
/** Model-specific weekly windows ("Current week (Sonnet only)") are not the main weekly limit. */
const MODEL_ONLY_LABEL = /\bonly\b/i;

function pickWindow(panel: ProviderPanel, match: (label: string) => boolean, now: number): UsageWindow | null {
  let best: UsageWindow | null = null;
  for (const row of panel.windows) {
    if (!match(row.label)) continue;
    // `markIfReset` may already have cleared a stale percent; windowAt keeps it cleared.
    const w = windowAt(row.usedPercent, parseIso(row.resetsAt), now);
    if (row.usedPercent === null && row.valueLabel === "reset") w.resetSince = true;
    if (!best || (w.percent ?? -1) > (best.percent ?? -1)) best = w;
  }
  return best;
}

/**
 * Row from a quota-windows panel (Codex, and Claude as a fallback). Window
 * labels are already relabelled, so a weekly Codex "5h limit" counts as weekly.
 */
export function rowFromPanel(panel: ProviderPanel, now: number): UsageRow {
  const fiveHour = pickWindow(panel, (l) => FIVE_HOUR_LABEL.test(l), now);
  const weekly = pickWindow(panel, (l) => WEEKLY_LABEL.test(l) && !MODEL_ONLY_LABEL.test(l), now);
  const known = Boolean(fiveHour || weekly);
  return {
    slug: panel.slug,
    label: panel.label,
    fiveHour,
    weekly,
    asOf: known ? panel.asOf : null,
    source: known ? "quota-windows" : null,
    reason: panel.state === "ok" ? (known ? null : "No 5-hour or weekly window reported") : panel.message,
  };
}

function percentText(w: UsageWindow | null): string {
  return w && w.percent !== null ? `${w.percent}%` : "—";
}

/** The next reset to show: the 5-hour one when known, else the weekly one. */
export function nextResetAt(row: UsageRow, now: number): number | null {
  for (const w of [row.fiveHour, row.weekly]) {
    if (w && w.percent !== null && w.resetsAt !== null && w.resetsAt > now) return w.resetsAt;
  }
  return null;
}

/** Compact reset time for the row: "0:05", "2:30" under 24 h; "3d4h", "6d" from 24 h. */
export function compactDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}:${String(totalMinutes % 60).padStart(2, "0")}`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d${hours}h`;
}

/** "10% 83% 2:14"; "—" when neither window is known. */
export function rowText(row: UsageRow, now: number): string {
  if (!hasKnownWindow(row)) return "—";
  const reset = nextResetAt(row, now);
  return `${percentText(row.fiveHour)} ${percentText(row.weekly)} ${reset !== null ? compactDuration(reset - now) : "—"}`;
}

function windowLine(name: string, w: UsageWindow | null, now: Date): string {
  if (!w) return `${name}: no data`;
  if (w.resetSince) {
    const at = w.resetsAt !== null ? ` at ${formatAsOf(w.resetsAt, now)}` : "";
    return `${name}: unknown (reset${at}, after the latest data)`;
  }
  const used = w.percent !== null ? `${w.percent}% used` : "unknown";
  if (w.resetsAt === null) return `${name}: ${used}`;
  return `${name}: ${used}, resets in ${formatDuration(w.resetsAt - now.getTime())} (${formatAsOf(w.resetsAt, now)})`;
}

const SOURCE_TEXT: Record<RowSource, string> = {
  "claude-usage-api": "Anthropic usage API",
  "quota-windows": "usage API",
};

/** Hover title: full labels, both reset times, source and age, and any reason. */
export function rowTitle(row: UsageRow, now: number): string {
  const nowDate = new Date(now);
  const lines = [`${row.label} usage limits`];
  if (row.account) lines.push(`Account: ${row.account}`);
  if (hasKnownWindow(row) || row.source) {
    lines.push(windowLine("5-hour window", row.fiveHour, nowDate));
    lines.push(windowLine("Weekly window", row.weekly, nowDate));
  }
  if (row.source && row.asOf !== null) lines.push(`Source: ${SOURCE_TEXT[row.source]}, as of ${formatAsOf(row.asOf, nowDate)}`);
  if (row.reason) lines.push(hasKnownWindow(row) ? `Note: ${row.reason}` : `No data: ${row.reason}`);
  else if (!hasKnownWindow(row) && !row.source) lines.push("No data yet");
  return lines.join("\n");
}
