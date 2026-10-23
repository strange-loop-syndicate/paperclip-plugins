import { useEffect, useState, useSyncExternalStore } from "react";
import { useHostContext, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { BASE_INTERVAL_MS, retryAt } from "../cache.ts";
import { buildPanels, type ProviderInfo } from "../mapping.ts";
import { hasKnownWindow, pickRow, rowFromPanel, rowFromSnapshot, rowText, rowTitle, type UsageRow } from "../rows.ts";
import { GaugeIcon, ProviderIcon } from "./icons.tsx";
import { getRunLogSnapshot, refreshRunLog, subscribeRunLog } from "./runlog-store.ts";
import { getSnapshot, refresh, subscribe } from "./store.ts";

/** How often each tab re-checks the shared caches; a fetch happens only when one is due. */
const TICK_MS = 30_000;

/**
 * The host's own sidebar nav item classes (`SidebarNavItem`), minus the link
 * hover/active states: same margin, padding, gap, font size, weight and colour,
 * so icon and text line up with Routines, Artifacts and the rest.
 */
export const NAV_ROW_CLASS =
  "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium transition-colors text-foreground/80";
/** The host wraps each nav icon in this span and sizes the icon h-4 w-4. */
export const NAV_ICON_SLOT_CLASS = "relative shrink-0";
export const NAV_ICON_CLASS = "h-4 w-4";
export const NAV_LABEL_CLASS = "min-w-0 flex-1 truncate";
/** Same spacing as the host's list of plugin sidebar items. */
const LIST_CLASS = "flex flex-col gap-0.5";

interface UsedProvidersData {
  providers: ProviderInfo[];
  agentIds?: Record<string, string[]>;
}

export interface RowView {
  slug: string;
  text: string;
  title: string;
}

export type UsageLimitsViewProps =
  | { kind: "hidden" }
  | { kind: "error"; message: string }
  | { kind: "rows"; rows: RowView[] };

function useTicker(active: boolean, onTick: () => void, deps: unknown[]) {
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (document.visibilityState === "visible") onTick();
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active, ...deps]);
}

/** Build the row views from both caches. Exported for the static preview. */
export function buildRowViews(
  used: ReadonlyArray<ProviderInfo>,
  runLog: ReturnType<typeof getRunLogSnapshot>,
  quota: ReturnType<typeof getSnapshot>,
  companyId: string,
  now: number,
): { rows: RowView[]; claudeNeedsQuota: boolean } {
  const panels = quota
    ? buildPanels(
        used,
        {
          results: quota.results,
          fetchedAt: quota.fetchedAt,
          fetchError: quota.fetchError,
          lastGood: quota.lastGood,
          retryAt: retryAt(quota),
        },
        new Date(now),
      )
    : [];
  const quotaLoaded = Boolean(quota && (quota.fetchedAt !== null || quota.fetchError !== null));
  const log = runLog && runLog.companyId === companyId ? runLog : null;
  let claudeNeedsQuota = false;

  const rows = used.map((info): RowView => {
    const panel = panels.find((p) => p.slug === info.slug);
    const fromQuota = panel && quotaLoaded ? rowFromPanel(panel, now) : null;
    let row: UsageRow | null;
    let loading: boolean;
    if (info.slug === "anthropic") {
      const fromLog = log?.checkedAt != null ? rowFromSnapshot(info, log.snapshot, now, log.error) : null;
      claudeNeedsQuota = Boolean(fromLog) && !hasKnownWindow(fromLog);
      row = pickRow(fromLog, claudeNeedsQuota ? fromQuota : null);
      loading = !fromLog || (claudeNeedsQuota && !quotaLoaded && !log?.snapshot);
    } else {
      row = fromQuota;
      loading = !quotaLoaded;
    }
    if (!row || (loading && !hasKnownWindow(row))) {
      return { slug: info.slug, text: loading ? "…" : "—", title: `${info.label} usage limits\n${loading ? "Loading" : "No data"}` };
    }
    return { slug: info.slug, text: rowText(row, now), title: rowTitle(row, now) };
  });
  return { rows, claudeNeedsQuota };
}

/** Sidebar rows: provider icon + "5h% / weekly% / next reset", one per used provider. */
export function UsageLimitsSidebar() {
  const { companyId } = useHostContext();
  const providersData = usePluginData<UsedProvidersData>("used-providers", { companyId: companyId ?? undefined });
  const used = providersData.data?.providers ?? [];
  const claudeIds = providersData.data?.agentIds?.anthropic ?? [];
  const runLog = useSyncExternalStore(subscribeRunLog, getRunLogSnapshot, () => null);
  const quota = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const [now, setNow] = useState(() => Date.now());

  // The provider list comes from this plugin's own worker, not from a provider API.
  const refreshProviders = providersData.refresh;
  useEffect(() => {
    if (!companyId) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refreshProviders();
    }, BASE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [companyId, refreshProviders]);

  const claudeKey = claudeIds.join(",");
  useTicker(Boolean(companyId) && claudeIds.length > 0, () => {
    setNow(Date.now());
    void refreshRunLog(companyId as string, claudeKey.split(","));
  }, [companyId, claudeKey]);

  const { rows, claudeNeedsQuota } = companyId
    ? buildRowViews(used, runLog, quota, companyId, now)
    : { rows: [], claudeNeedsQuota: false };

  // Quota windows: Codex always, Claude only as a fallback. Each call of that
  // route also polls Anthropic, so skip it when nothing needs it.
  const needed = used
    .map((p) => p.slug)
    .filter((slug) => slug === "openai" || (slug === "anthropic" && claudeNeedsQuota));
  const neededKey = needed.join(",");
  useTicker(Boolean(companyId) && needed.length > 0, () => {
    setNow(Date.now());
    void refresh(companyId as string, neededKey.split(","), false);
  }, [companyId, neededKey]);

  if (!companyId) return null;
  if (providersData.error) return <UsageLimitsView kind="error" message={providersData.error.message} />;
  if (rows.length === 0) return <UsageLimitsView kind="hidden" />;
  return <UsageLimitsView kind="rows" rows={rows} />;
}

/** Presentational part, no data fetching. */
export function UsageLimitsView(props: UsageLimitsViewProps) {
  if (props.kind === "hidden") return null;
  const rows: Array<RowView & { icon: "provider" | "gauge" }> =
    props.kind === "rows"
      ? props.rows.map((r) => ({ ...r, icon: "provider" }))
      : [{ slug: "error", text: "—", title: `Usage limits unavailable\n${props.message}`, icon: "gauge" }];
  return (
    <div className={LIST_CLASS} data-plugin="lab.usage-limits">
      {rows.map((row) => (
        <div
          key={row.slug}
          className={NAV_ROW_CLASS}
          title={row.title}
          aria-label={row.title.replace(/\n/g, ". ")}
          data-provider={row.slug}
        >
          <span data-slot="sidebar-nav-icon" className={NAV_ICON_SLOT_CLASS}>
            {row.icon === "gauge" ? <GaugeIcon className={NAV_ICON_CLASS} /> : <ProviderIcon slug={row.slug} className={NAV_ICON_CLASS} />}
          </span>
          <span className={NAV_LABEL_CLASS} style={{ fontVariantNumeric: "tabular-nums" }}>
            {row.text}
          </span>
        </div>
      ))}
    </div>
  );
}
