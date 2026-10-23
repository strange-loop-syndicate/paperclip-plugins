import { useCallback, useEffect, useRef, useState } from "react";
import { useHostContext, usePluginData } from "@paperclipai/plugin-sdk/ui";
import {
  buildPanels,
  type ProviderInfo,
  type ProviderPanel,
  type ProviderQuotaResult,
  type Severity,
  type WindowRow,
} from "../mapping.ts";

/** Each quota fetch hits the provider APIs, so poll slowly. */
export const REFRESH_MS = 120_000;
/** Minimum gap before a tab-focus refresh. */
const FOCUS_REFRESH_MIN_GAP_MS = 30_000;

interface QuotaState {
  results: ProviderQuotaResult[] | null;
  error: string | null;
  loading: boolean;
  fetchedAt: Date | null;
}

async function fetchQuotaWindows(companyId: string, signal: AbortSignal): Promise<ProviderQuotaResult[]> {
  const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/costs/quota-windows`, {
    credentials: "include",
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    let reason = `${res.status} ${res.statusText}`.trim();
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") reason = `${reason}: ${body.error}`;
    } catch {
      // keep the status line
    }
    throw new Error(`Quota request failed (${reason})`);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("Quota response was not a list");
  return body as ProviderQuotaResult[];
}

function useQuotaWindows(companyId: string | null, enabled: boolean) {
  const [state, setState] = useState<QuotaState>({ results: null, error: null, loading: false, fetchedAt: null });
  const lastFetchRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!companyId || !enabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    lastFetchRef.current = Date.now();
    setState((s) => ({ ...s, loading: true }));
    try {
      const results = await fetchQuotaWindows(companyId, controller.signal);
      if (!controller.signal.aborted) setState({ results, error: null, loading: false, fetchedAt: new Date() });
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setState({ results: null, error: message, loading: false, fetchedAt: new Date() });
    }
  }, [companyId, enabled]);

  useEffect(() => {
    if (!companyId || !enabled) return;
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastFetchRef.current >= FOCUS_REFRESH_MIN_GAP_MS) {
        void load();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      abortRef.current?.abort();
    };
  }, [companyId, enabled, load]);

  return { ...state, reload: load };
}

const SEVERITY_COLOR: Record<Severity, string> = {
  ok: "#16a34a",
  warn: "#d97706",
  critical: "#dc2626",
  unknown: "#9ca3af",
};

const styles = {
  root: { display: "grid", gap: 8, padding: "8px 12px", fontSize: 12, lineHeight: 1.3 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 },
  title: { fontWeight: 600, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 0.4, opacity: 0.7 },
  refresh: {
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontSize: 12,
    opacity: 0.6,
    padding: 0,
  },
  provider: { display: "grid", gap: 4 },
  providerName: { fontWeight: 600 },
  row: { display: "grid", gap: 2 },
  rowLine: { display: "flex", justifyContent: "space-between", gap: 6 },
  muted: { opacity: 0.6 },
  track: { height: 4, borderRadius: 2, background: "rgba(127,127,127,0.25)", overflow: "hidden" },
  unavailable: { color: "#dc2626" },
};

function formatAbsolute(resetsAt: string | null): string | undefined {
  if (!resetsAt) return undefined;
  const d = new Date(resetsAt);
  return Number.isNaN(d.getTime()) ? undefined : `Resets ${d.toLocaleString()}`;
}

function WindowLine({ row }: { row: WindowRow }) {
  const value = row.usedPercent !== null ? `${row.usedPercent}%` : row.valueLabel ?? "—";
  return (
    <div style={styles.row} title={[row.detail, formatAbsolute(row.resetsAt)].filter(Boolean).join("\n") || undefined}>
      <div style={styles.rowLine}>
        <span>{row.label}</span>
        <span style={{ color: SEVERITY_COLOR[row.severity], fontVariantNumeric: "tabular-nums" }}>{value}</span>
      </div>
      {row.usedPercent !== null ? (
        <div style={styles.track} role="progressbar" aria-valuenow={row.usedPercent} aria-valuemin={0} aria-valuemax={100} aria-label={`${row.label} used`}>
          <div style={{ width: `${row.usedPercent}%`, height: "100%", background: SEVERITY_COLOR[row.severity] }} />
        </div>
      ) : null}
      {row.resetIn ? <span style={styles.muted}>resets {row.resetIn}</span> : null}
    </div>
  );
}

function ProviderBlock({ panel }: { panel: ProviderPanel }) {
  return (
    <div style={styles.provider} data-provider={panel.slug} data-state={panel.state}>
      <span style={styles.providerName}>{panel.label}</span>
      {panel.state === "unavailable" ? (
        <span style={styles.unavailable} title={panel.message ?? undefined}>
          Unavailable{panel.message ? ` — ${panel.message}` : ""}
        </span>
      ) : null}
      {panel.state === "empty" ? <span style={styles.muted}>{panel.message}</span> : null}
      {panel.windows.map((row) => (
        <WindowLine key={row.label} row={row} />
      ))}
    </div>
  );
}

export function UsageLimitsSidebarPanel() {
  const { companyId } = useHostContext();
  const providersData = usePluginData<{ providers: ProviderInfo[] }>("used-providers", {
    companyId: companyId ?? undefined,
  });
  const used = providersData.data?.providers ?? [];
  const quota = useQuotaWindows(companyId, used.length > 0);

  // Re-check which providers are in use on the same slow cadence.
  const refreshProviders = providersData.refresh;
  useEffect(() => {
    if (!companyId) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshProviders();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [companyId, refreshProviders]);

  if (!companyId) return null;

  let view: UsageLimitsViewProps["view"];
  if (providersData.error) {
    view = { kind: "error", message: providersData.error.message };
  } else if ((providersData.loading && !providersData.data) || (used.length > 0 && !quota.fetchedAt)) {
    view = { kind: "loading" };
  } else if (used.length === 0) {
    view = { kind: "none" };
  } else {
    view = { kind: "panels", panels: buildPanels(used, quota.results, quota.error, new Date()) };
  }

  return (
    <UsageLimitsView
      view={view}
      loading={quota.loading}
      updatedAt={quota.fetchedAt}
      onRefresh={() => {
        refreshProviders();
        void quota.reload();
      }}
    />
  );
}

export interface UsageLimitsViewProps {
  view:
    | { kind: "loading" }
    | { kind: "none" }
    | { kind: "error"; message: string }
    | { kind: "panels"; panels: ProviderPanel[] };
  loading: boolean;
  updatedAt: Date | null;
  onRefresh?: () => void;
}

/** Presentational part of the panel; no data fetching. */
export function UsageLimitsView({ view, loading, updatedAt, onRefresh }: UsageLimitsViewProps) {
  return (
    <div style={styles.root} data-plugin="lab.usage-limits">
      <div style={styles.header}>
        <span style={styles.title}>Usage limits</span>
        <button
          type="button"
          style={styles.refresh}
          onClick={onRefresh}
          disabled={loading}
          title={updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Refresh"}
          aria-label="Refresh usage limits"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>
      {view.kind === "loading" ? <span style={styles.muted}>Loading…</span> : null}
      {view.kind === "none" ? <span style={styles.muted}>No Claude or Codex agents</span> : null}
      {view.kind === "error" ? <span style={styles.unavailable}>Unavailable — {view.message}</span> : null}
      {view.kind === "panels" ? view.panels.map((panel) => <ProviderBlock key={panel.slug} panel={panel} />) : null}
    </div>
  );
}
