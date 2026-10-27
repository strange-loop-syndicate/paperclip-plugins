// Pure data mapping: company agents + quota-windows response -> sidebar panels.
// No imports from the SDK or React, so `node --test` can load it directly.

/** One quota window, as returned by GET /api/companies/:id/costs/quota-windows. */
export interface QuotaWindow {
  label: string;
  usedPercent: number | null;
  resetsAt: string | null;
  valueLabel: string | null;
  detail?: string | null;
}

/** One provider entry from the quota-windows endpoint. */
export interface ProviderQuotaResult {
  provider: string;
  source?: string | null;
  ok: boolean;
  errorFamily?: string | null;
  error?: string;
  windows: QuotaWindow[];
}

export interface ProviderInfo {
  /** Provider slug used by the quota-windows endpoint. */
  slug: string;
  /** Name shown in the sidebar. */
  label: string;
}

export type Severity = "ok" | "warn" | "critical" | "unknown";

export interface WindowRow {
  label: string;
  /** 0-100, rounded; null when the provider does not report a percentage. */
  usedPercent: number | null;
  severity: Severity;
  valueLabel: string | null;
  resetsAt: string | null;
  /** Relative reset text, e.g. "in 3h 05m"; null when unknown. */
  resetIn: string | null;
  detail: string | null;
}

export type PanelState = "ok" | "stale" | "empty" | "unavailable";

export interface ProviderPanel {
  slug: string;
  label: string;
  state: PanelState;
  /** Short reason for "stale", "empty" and "unavailable" states. */
  message: string | null;
  /** Full error text from the server, for the tooltip only. */
  errorDetail: string | null;
  /** When the shown windows were fetched (ms epoch); set for "ok" and "stale". */
  asOf: number | null;
  windows: WindowRow[];
  /** Rows kept out of the panel and shown in the tooltip only (e.g. $0 credits). */
  tooltipOnly: WindowRow[];
}

/** Last successful windows for one provider, kept across failed fetches. */
export interface LastGood {
  windows: QuotaWindow[];
  /** ms epoch of the response that carried these windows. */
  fetchedAt: number;
  source?: string | null;
}

export interface PanelInput {
  /** Latest quota-windows response; null when none yet or the latest fetch failed. */
  results: ReadonlyArray<ProviderQuotaResult> | null;
  /** When `results` arrived (ms epoch). */
  fetchedAt: number | null;
  /** Why the latest fetch failed as a whole (HTTP error, network); null otherwise. */
  fetchError: string | null;
  /** Last good windows per provider slug. */
  lastGood: Readonly<Record<string, LastGood>>;
  /** Next automatic attempt (ms epoch) while backing off; null when not backing off. */
  retryAt: number | null;
}

/** Adapter types that report quota windows, mapped to the server's provider slug. */
export const ADAPTER_PROVIDERS: Readonly<Record<string, ProviderInfo>> = {
  claude_local: { slug: "anthropic", label: "Claude" },
  codex_local: { slug: "openai", label: "Codex" },
};

const PROVIDER_ORDER = ["anthropic", "openai"];
const PROVIDER_VENDOR: Readonly<Record<string, string>> = { anthropic: "Anthropic", openai: "OpenAI" };
const HOUR_MS = 3_600_000;
/** Clock skew allowed before a "5h" label is called wrong. */
const RELABEL_TOLERANCE_MS = 5 * 60_000;

export const WARN_PERCENT = 75;
export const CRITICAL_PERCENT = 90;

/**
 * Providers used by at least one non-terminated agent, in a stable order.
 * Agents on adapters without quota windows are ignored.
 */
export function usedProviders(
  agents: ReadonlyArray<{ adapterType?: string | null; status?: string | null }>,
): ProviderInfo[] {
  const bySlug = new Map<string, ProviderInfo>();
  for (const agent of agents) {
    if (agent.status === "terminated") continue;
    const info = agent.adapterType ? ADAPTER_PROVIDERS[agent.adapterType] : undefined;
    if (info) bySlug.set(info.slug, info);
  }
  return [...bySlug.values()].sort(
    (a, b) => PROVIDER_ORDER.indexOf(a.slug) - PROVIDER_ORDER.indexOf(b.slug),
  );
}

export function severityFor(usedPercent: number | null): Severity {
  if (usedPercent === null) return "unknown";
  if (usedPercent >= CRITICAL_PERCENT) return "critical";
  if (usedPercent >= WARN_PERCENT) return "warn";
  return "ok";
}

export function normalizePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)));
}

/** "42m", "3h 05m", "2d 4h"; "0m" for zero or less. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** "in 42m", "in 3h 05m", "in 2d 4h", "now"; null for a missing or invalid time. */
export function formatResetIn(resetsAt: string | null, now: Date): string | null {
  if (!resetsAt) return null;
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return null;
  if (Math.ceil((resetMs - now.getTime()) / 60_000) <= 0) return "now";
  return `in ${formatDuration(resetMs - now.getTime())}`;
}

/** Local "HH:MM" for an "as of" marker. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "HH:MM" for today, "M/D HH:MM" for an older day, so old stale data does not read as today's. */
export function formatAsOf(ms: number, now: Date): string {
  const d = new Date(ms);
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? formatClock(ms) : `${d.getMonth() + 1}/${d.getDate()} ${formatClock(ms)}`;
}

/**
 * Fix a window label that its own reset time contradicts.
 *
 * The Codex adapter labels `primary_window` "5h limit" whatever its length. On
 * accounts where the primary window is weekly, that reads "5h limit … resets in
 * 6d 23h". A "5h" label whose reset is more than 5 h away becomes "Weekly limit";
 * any prefix (e.g. "GPT-5 · ") is kept. Other labels pass through unchanged.
 */
export function relabelWindow(label: string, resetsAt: string | null, now: Date): string {
  if (!/\b5\s*h\b/i.test(label) || !resetsAt) return label;
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return label;
  if (resetMs - now.getTime() <= 5 * HOUR_MS + RELABEL_TOLERANCE_MS) return label;
  return label.replace(/\b5\s*h\b(\s*limit\b)?/i, "Weekly limit");
}

/**
 * A credits row that only says "$0.00 remaining" next to subscription
 * percentage windows carries no signal; it goes to the tooltip instead.
 */
export function isZeroCreditRow(row: WindowRow, siblings: ReadonlyArray<WindowRow>): boolean {
  if (row.usedPercent !== null || !/credit/i.test(row.label)) return false;
  if (!/^\$?0+(\.0+)?(?![\d.])/.test((row.valueLabel ?? "").trim())) return false;
  return siblings.some((s) => s !== row && s.usedPercent !== null);
}

/**
 * Short, human error text for the sidebar, e.g.
 * "Rate-limited by Anthropic, retrying in 10m". The full text goes to the tooltip.
 *
 * @param slug provider slug, or null for a failure of the whole request
 */
export function shortError(slug: string | null, raw: string, retryAt: number | null, now: Date): string {
  const vendor = slug ? PROVIDER_VENDOR[slug] : undefined;
  let text: string;
  if (/\b429\b|rate[\s-]?limit|too many requests/i.test(raw)) {
    text = vendor ? `Rate-limited by ${vendor}` : "Rate-limited";
  } else if (/timed out|timeout/i.test(raw)) {
    text = "Timed out";
  } else if (/\b40[13]\b|unauthori[sz]ed|forbidden|auth|token|log\s?in|sign\s?in/i.test(raw)) {
    text = "Auth failed";
  } else if (/no quota data|not loaded/i.test(raw)) {
    text = "No quota data";
  } else {
    text = slug ? "Lookup failed" : "Usage request failed";
  }
  if (retryAt !== null && retryAt > now.getTime()) {
    text += `, retrying in ${formatDuration(retryAt - now.getTime())}`;
  }
  return text;
}

export function toWindowRow(window: QuotaWindow, now: Date): WindowRow {
  const usedPercent = normalizePercent(window.usedPercent);
  const resetsAt = window.resetsAt ?? null;
  return {
    label: relabelWindow(window.label || "Window", resetsAt, now),
    usedPercent,
    severity: severityFor(usedPercent),
    valueLabel: window.valueLabel ?? null,
    resetsAt,
    resetIn: formatResetIn(resetsAt, now),
    detail: window.detail ?? null,
  };
}

function splitRows(windows: ReadonlyArray<QuotaWindow>, now: Date): Pick<ProviderPanel, "windows" | "tooltipOnly"> {
  const rows = (Array.isArray(windows) ? windows : []).map((w) => toWindowRow(w, now));
  const tooltipOnly = rows.filter((r) => isZeroCreditRow(r, rows));
  return { windows: rows.filter((r) => !tooltipOnly.includes(r)), tooltipOnly };
}

/**
 * A stale row whose window has reset since the data was fetched: its old
 * percent is known to be wrong, so it shows "reset" with no percent instead.
 */
export function markIfReset(row: WindowRow, now: Date): WindowRow {
  const resetMs = row.resetsAt ? Date.parse(row.resetsAt) : Number.NaN;
  if (Number.isNaN(resetMs) || resetMs > now.getTime()) return row;
  return { ...row, usedPercent: null, severity: "unknown", valueLabel: "reset", resetIn: null };
}

/** The provider entry to use when the server returns more than one: an ok one first. */
export function pickResult(
  results: ReadonlyArray<ProviderQuotaResult>,
  slug: string,
): ProviderQuotaResult | undefined {
  const matches = results.filter((r) => r.provider === slug);
  return matches.find((r) => r.ok) ?? matches[0];
}

/**
 * Build one panel per used provider.
 *
 * A provider that fails now but has older good windows shows them as "stale"
 * with a short reason. Only a provider with no good data at all is "unavailable".
 */
export function buildPanels(used: ReadonlyArray<ProviderInfo>, input: PanelInput, now: Date): ProviderPanel[] {
  return used.map((info): ProviderPanel => {
    const base = { slug: info.slug, label: info.label, tooltipOnly: [] as WindowRow[] };
    const result = input.results ? pickResult(input.results, info.slug) : undefined;

    if (result?.ok) {
      const rows = splitRows(result.windows, now);
      if (rows.windows.length === 0 && rows.tooltipOnly.length === 0) {
        return { ...base, state: "empty", message: "No quota windows reported", errorDetail: null, asOf: input.fetchedAt, windows: [] };
      }
      return { ...base, ...rows, state: "ok", message: null, errorDetail: null, asOf: input.fetchedAt };
    }

    let raw: string;
    let errorSlug: string | null = info.slug;
    if (input.results === null) {
      raw = input.fetchError ?? "Quota data not loaded";
      errorSlug = null;
    } else if (!result) {
      raw = "Provider reported no quota data";
    } else {
      raw = result.error || result.errorFamily || "Quota lookup failed";
    }
    const message = shortError(errorSlug, raw, input.retryAt, now);
    const errorDetail = raw.replace(/\s+/g, " ").trim();

    const good = input.lastGood[info.slug];
    if (good && good.windows.length > 0) {
      const rows = splitRows(good.windows, now);
      return {
        ...base,
        windows: rows.windows.map((r) => markIfReset(r, now)),
        tooltipOnly: rows.tooltipOnly.map((r) => markIfReset(r, now)),
        state: "stale",
        message,
        errorDetail,
        asOf: good.fetchedAt,
      };
    }
    return { ...base, state: "unavailable", message, errorDetail, asOf: null, windows: [] };
  });
}
