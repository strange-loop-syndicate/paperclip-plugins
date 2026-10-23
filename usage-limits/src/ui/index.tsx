import { useEffect, useState, useSyncExternalStore, type AnchorHTMLAttributes } from "react";
import { useHostContext, useHostNavigation, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { BASE_INTERVAL_MS, retryAt, type FetchDecision } from "../cache.ts";
import {
  buildPanels,
  compactItem,
  formatClock,
  formatDuration,
  tooltipText,
  type CompactItem,
  type ProviderInfo,
  type ProviderPanel,
  type Severity,
  type WindowRow,
} from "../mapping.ts";
import { getSnapshot, isBusy, refresh, subscribe } from "./store.ts";

/** How often each tab re-checks the shared cache; a fetch happens only when it is due. */
const TICK_MS = 30_000;

const SEVERITY_COLOR: Record<Severity, string> = {
  ok: "#16a34a",
  warn: "#d97706",
  critical: "#dc2626",
  unknown: "#9ca3af",
};
const STALE_COLOR = "#d97706";
const ERROR_COLOR = "#dc2626";

/** Same classes as the host's own nav rows, so the line sits in the nav list. */
const NAV_ROW_CLASS =
  "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 text-(length:--text-compact) font-medium transition-colors text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

const styles = {
  navRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "calc(100% - 16px)",
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    textAlign: "left" as const,
    font: "inherit",
  },
  line: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  item: { whiteSpace: "nowrap" as const },
  sep: { opacity: 0.5 },
  tag: { fontSize: "0.8em", marginLeft: 3, opacity: 0.85 },
  caret: { opacity: 0.5, fontSize: "0.8em" },
  detailBox: { margin: "2px 8px 6px", padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(127,127,127,0.25)" },
  root: { display: "grid", gap: 8, fontSize: 12, lineHeight: 1.3 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 },
  title: { fontWeight: 600, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 0.4, opacity: 0.7 },
  headerRight: { display: "flex", alignItems: "center", gap: 8 },
  link: { color: "inherit", opacity: 0.7, fontSize: 11 },
  refresh: { border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12, opacity: 0.6, padding: 0 },
  provider: { display: "grid", gap: 4 },
  providerName: { fontWeight: 600 },
  status: { fontSize: 11 },
  row: { display: "grid", gap: 2 },
  rowLine: { display: "flex", justifyContent: "space-between", gap: 6 },
  muted: { opacity: 0.6 },
  track: { height: 4, borderRadius: 2, background: "rgba(127,127,127,0.25)", overflow: "hidden" },
};

function GaugeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 11.5 10.8 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function useQuota(companyId: string | null, usedSlugs: string[]) {
  const cache = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const busy = useSyncExternalStore(subscribe, isBusy, () => false);
  const [now, setNow] = useState(() => Date.now());
  const enabled = Boolean(companyId) && usedSlugs.length > 0;
  const slugKey = usedSlugs.join(",");

  useEffect(() => {
    if (!companyId || !enabled) return;
    const slugs = slugKey.split(",");
    const tick = () => {
      setNow(Date.now());
      if (document.visibilityState === "visible") void refresh(companyId, slugs, false);
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [companyId, enabled, slugKey]);

  const manualRefresh = async (): Promise<FetchDecision | null> => {
    if (!companyId || !enabled) return null;
    const decision = await refresh(companyId, slugKey.split(","), true);
    setNow(Date.now());
    return decision;
  };

  return { cache, busy, now, manualRefresh };
}

function refusedNotice(decision: FetchDecision | null): string | null {
  if (!decision || decision.fetch) return null;
  if (decision.reason === "in-flight") return "Refresh already running";
  return `Next refresh in ${Math.max(1, Math.ceil(decision.waitMs / 1000))}s`;
}

/** Sidebar nav entry: "Claude 82% · Codex 0%", expands to the full detail. */
export function UsageLimitsSidebar() {
  const { companyId } = useHostContext();
  const navigation = useHostNavigation();
  const providersData = usePluginData<{ providers: ProviderInfo[] }>("used-providers", {
    companyId: companyId ?? undefined,
  });
  const used = providersData.data?.providers ?? [];
  const quota = useQuota(companyId, used.map((p) => p.slug));
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The provider list comes from this plugin's own worker, not from a provider API.
  const refreshProviders = providersData.refresh;
  useEffect(() => {
    if (!companyId) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshProviders();
    }, BASE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [companyId, refreshProviders]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4_000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!companyId) return null;

  const cache = quota.cache;
  let view: UsageLimitsViewProps["view"];
  if (providersData.error) {
    view = { kind: "error", message: providersData.error.message };
  } else if (providersData.loading && !providersData.data) {
    view = { kind: "loading" };
  } else if (used.length === 0) {
    view = { kind: "none" };
  } else if (!cache || (cache.fetchedAt === null && cache.fetchError === null)) {
    view = { kind: "loading" };
  } else {
    const nowDate = new Date(quota.now);
    const input = {
      results: cache.results,
      fetchedAt: cache.fetchedAt,
      fetchError: cache.fetchError,
      lastGood: cache.lastGood,
      retryAt: retryAt(cache),
    };
    const panels = buildPanels(used, input, nowDate);
    view = { kind: "panels", panels, items: panels.map((p) => compactItem(p, input, nowDate)) };
  }

  return (
    <UsageLimitsView
      view={view}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      loading={quota.busy}
      notice={notice}
      costsLink={navigation.linkProps("/costs")}
      onRefresh={() => {
        refreshProviders();
        void quota.manualRefresh().then((d) => setNotice(refusedNotice(d)));
      }}
    />
  );
}

export interface UsageLimitsViewProps {
  view:
    | { kind: "loading" }
    | { kind: "none" }
    | { kind: "error"; message: string }
    | { kind: "panels"; panels: ProviderPanel[]; items: CompactItem[] };
  expanded: boolean;
  onToggle?: () => void;
  loading: boolean;
  notice: string | null;
  costsLink?: AnchorHTMLAttributes<HTMLAnchorElement>;
  onRefresh?: () => void;
}

function CompactValue({ item }: { item: CompactItem }) {
  const stale = item.state === "stale";
  const color = item.percent === null ? SEVERITY_COLOR.unknown : SEVERITY_COLOR[item.severity];
  return (
    <span style={styles.item} data-provider={item.slug} data-state={item.state}>
      {item.label}{" "}
      <span style={{ color, fontVariantNumeric: "tabular-nums", opacity: stale ? 0.65 : 1 }}>
        {item.percent === null ? "—" : `${item.percent}%`}
      </span>
      {item.tag ? (
        <span style={{ ...styles.tag, color: item.state === "unavailable" ? ERROR_COLOR : STALE_COLOR }}>{item.tag}</span>
      ) : null}
    </span>
  );
}

/** Presentational part: the nav line and, when expanded, the detail. No data fetching. */
export function UsageLimitsView(props: UsageLimitsViewProps) {
  const { view, expanded, onToggle } = props;
  let line;
  let title: string;
  if (view.kind === "panels") {
    line = view.items.map((item, i) => (
      <span key={item.slug}>
        {i > 0 ? <span style={styles.sep}> · </span> : null}
        <CompactValue item={item} />
      </span>
    ));
    title = tooltipText(view.panels);
  } else if (view.kind === "loading") {
    line = <span style={styles.muted}>Usage limits…</span>;
    title = "Loading usage limits";
  } else if (view.kind === "none") {
    line = <span style={styles.muted}>Usage limits: none</span>;
    title = "No Claude or Codex agents in this company";
  } else {
    line = <span style={{ color: ERROR_COLOR }}>Usage limits unavailable</span>;
    title = view.message;
  }

  return (
    <div data-plugin="lab.usage-limits" data-view={view.kind}>
      <button
        type="button"
        className={NAV_ROW_CLASS}
        style={styles.navRow}
        title={title}
        aria-expanded={expanded}
        aria-label={`Usage limits. ${title}`}
        onClick={onToggle}
      >
        <GaugeIcon />
        <span style={styles.line}>{line}</span>
        <span style={styles.caret} aria-hidden="true">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded ? (
        <div style={styles.detailBox}>
          <UsageDetailView {...props} />
        </div>
      ) : null}
    </div>
  );
}

function formatAbsolute(resetsAt: string | null): string | undefined {
  if (!resetsAt) return undefined;
  const d = new Date(resetsAt);
  return Number.isNaN(d.getTime()) ? undefined : `Resets ${d.toLocaleString()}`;
}

function WindowLine({ row, stale }: { row: WindowRow; stale: boolean }) {
  const value = row.usedPercent !== null ? `${row.usedPercent}%` : row.valueLabel ?? "—";
  return (
    <div style={{ ...styles.row, opacity: stale ? 0.7 : 1 }} title={[row.detail, formatAbsolute(row.resetsAt)].filter(Boolean).join("\n") || undefined}>
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

function ProviderStatus({ panel }: { panel: ProviderPanel }) {
  const full = panel.errorDetail ?? undefined;
  if (panel.state === "ok" && panel.asOf !== null) {
    return <span style={{ ...styles.status, ...styles.muted }}>as of {formatClock(panel.asOf)}</span>;
  }
  if (panel.state === "stale") {
    return (
      <span style={{ ...styles.status, color: STALE_COLOR }} title={full}>
        stale · as of {panel.asOf !== null ? formatClock(panel.asOf) : "?"} — {panel.message}
      </span>
    );
  }
  if (panel.state === "unavailable") {
    return (
      <span style={{ ...styles.status, color: ERROR_COLOR }} title={full}>
        {panel.message}
      </span>
    );
  }
  return <span style={{ ...styles.status, ...styles.muted }}>{panel.message}</span>;
}

function ProviderBlock({ panel }: { panel: ProviderPanel }) {
  return (
    <div style={styles.provider} data-provider={panel.slug} data-state={panel.state}>
      <span style={styles.providerName}>{panel.label}</span>
      <ProviderStatus panel={panel} />
      {panel.windows.map((row, i) => (
        <WindowLine key={`${i}-${row.label}`} row={row} stale={panel.state === "stale"} />
      ))}
    </div>
  );
}

function UsageDetailView({ view, loading, notice, costsLink, onRefresh }: UsageLimitsViewProps) {
  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>Usage limits</span>
        <span style={styles.headerRight}>
          {notice ? <span style={{ ...styles.muted, fontSize: 11 }}>{notice}</span> : null}
          {costsLink ? (
            <a {...costsLink} style={styles.link}>
              Costs
            </a>
          ) : null}
          <button
            type="button"
            style={styles.refresh}
            onClick={onRefresh}
            disabled={loading}
            title={`Refresh (at most once per minute; automatic every ${formatDuration(BASE_INTERVAL_MS)})`}
            aria-label="Refresh usage limits"
          >
            {loading ? "…" : "↻"}
          </button>
        </span>
      </div>
      {view.kind === "loading" ? <span style={styles.muted}>Loading…</span> : null}
      {view.kind === "none" ? <span style={styles.muted}>No Claude or Codex agents</span> : null}
      {view.kind === "error" ? <span style={{ color: ERROR_COLOR }} title={view.message}>Unavailable</span> : null}
      {view.kind === "panels" ? view.panels.map((panel) => <ProviderBlock key={panel.slug} panel={panel} />) : null}
    </div>
  );
}
