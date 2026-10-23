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

export type PanelState = "ok" | "empty" | "unavailable";

export interface ProviderPanel {
  slug: string;
  label: string;
  state: PanelState;
  /** Reason text for "empty" and "unavailable" states. */
  message: string | null;
  windows: WindowRow[];
}

/** Adapter types that report quota windows, mapped to the server's provider slug. */
export const ADAPTER_PROVIDERS: Readonly<Record<string, ProviderInfo>> = {
  claude_local: { slug: "anthropic", label: "Claude" },
  codex_local: { slug: "openai", label: "Codex" },
};

const PROVIDER_ORDER = ["anthropic", "openai"];
const MAX_MESSAGE_LENGTH = 160;

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

/** "in 42m", "in 3h 05m", "in 2d 4h", "now"; null for a missing or invalid time. */
export function formatResetIn(resetsAt: string | null, now: Date): string | null {
  if (!resetsAt) return null;
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return null;
  const totalMinutes = Math.ceil((resetMs - now.getTime()) / 60_000);
  if (totalMinutes <= 0) return "now";
  if (totalMinutes < 60) return `in ${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = String(totalMinutes % 60).padStart(2, "0");
    return `in ${totalHours}h ${minutes}m`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `in ${days}d` : `in ${days}d ${hours}h`;
}

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_MESSAGE_LENGTH
    ? `${oneLine.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : oneLine;
}

export function toWindowRow(window: QuotaWindow, now: Date): WindowRow {
  const usedPercent = normalizePercent(window.usedPercent);
  return {
    label: window.label || "Window",
    usedPercent,
    severity: severityFor(usedPercent),
    valueLabel: window.valueLabel ?? null,
    resetsAt: window.resetsAt ?? null,
    resetIn: formatResetIn(window.resetsAt ?? null, now),
    detail: window.detail ?? null,
  };
}

/**
 * Build one panel per used provider.
 *
 * @param results quota-windows response, or null when the fetch failed
 * @param fetchError reason the fetch failed; marks every panel unavailable
 */
export function buildPanels(
  used: ReadonlyArray<ProviderInfo>,
  results: ReadonlyArray<ProviderQuotaResult> | null,
  fetchError: string | null,
  now: Date,
): ProviderPanel[] {
  return used.map((info): ProviderPanel => {
    const base = { slug: info.slug, label: info.label };
    if (fetchError !== null || results === null) {
      return {
        ...base,
        state: "unavailable",
        message: shorten(fetchError ?? "Quota data not loaded"),
        windows: [],
      };
    }
    const matches = results.filter((r) => r.provider === info.slug);
    const result = matches.find((r) => r.ok) ?? matches[0];
    if (!result) {
      return { ...base, state: "unavailable", message: "Provider reported no quota data", windows: [] };
    }
    if (!result.ok) {
      return {
        ...base,
        state: "unavailable",
        message: shorten(result.error || result.errorFamily || "Quota lookup failed"),
        windows: [],
      };
    }
    const windows = (Array.isArray(result.windows) ? result.windows : []).map((w) => toWindowRow(w, now));
    if (windows.length === 0) {
      return { ...base, state: "empty", message: "No quota windows reported", windows };
    }
    return { ...base, state: "ok", message: null, windows };
  });
}
