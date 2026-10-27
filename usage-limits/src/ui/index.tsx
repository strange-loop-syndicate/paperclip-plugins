import { useEffect, useState, useSyncExternalStore } from "react";
import { useHostContext, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { BASE_INTERVAL_MS, retryAt } from "../cache.ts";
import { buildPanels, type ProviderInfo } from "../mapping.ts";
import type { ClaudeUsage } from "../claude-usage.ts";
import { hasKnownWindow, rowFromClaudeUsage, rowFromPanel, rowText, rowTitle, type UsageRow } from "../rows.ts";
import { GaugeIcon, ProviderIcon } from "./icons.tsx";
import { getSnapshot, refresh, subscribe } from "./store.ts";

/** How often each tab re-checks the shared caches; a fetch happens only when one is due. */
const TICK_MS = 30_000;
/** Claude: ask the worker once a minute. It polls the API only when usage-exact.json is 60 s old. */
const CLAUDE_TICK_MS = 60_000;

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

function useTicker(active: boolean, onTick: () => void, deps: unknown[], intervalMs = TICK_MS) {
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (document.visibilityState === "visible") onTick();
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active, ...deps]);
}

function claudeUnavailable(reason: string): ClaudeUsage {
  return { fiveHour: null, sevenDay: null, asOf: null, account: null, reason };
}

/** Build the row views from the Claude reading and the quota cache. Exported for the static preview. */
export function buildRowViews(
  used: ReadonlyArray<ProviderInfo>,
  claude: { data: ClaudeUsage | null; error: string | null },
  quota: ReturnType<typeof getSnapshot>,
  now: number,
): RowView[] {
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

  return used.map((info): RowView => {
    let row: UsageRow | null;
    let loading: boolean;
    if (info.slug === "anthropic") {
      // A failed worker call is a row with no data, unknown account and the error as its reason.
      const usage = claude.data ?? (claude.error ? claudeUnavailable(claude.error) : null);
      row = usage ? rowFromClaudeUsage(info, usage, now) : null;
      loading = !usage;
    } else {
      const panel = panels.find((p) => p.slug === info.slug);
      row = panel && quotaLoaded ? rowFromPanel(panel, now) : null;
      loading = !quotaLoaded;
    }
    if (!row || (loading && !hasKnownWindow(row))) {
      return { slug: info.slug, text: loading ? "…" : "—", title: `${info.label} usage limits\n${loading ? "Loading" : "No data"}` };
    }
    return { slug: info.slug, text: rowText(row, now), title: rowTitle(row, now) };
  });
}

/** Sidebar rows: provider icon + "5h% weekly% next-reset", one per used provider. */
export function UsageLimitsSidebar() {
  const { companyId } = useHostContext();
  const providersData = usePluginData<UsedProvidersData>("used-providers", { companyId: companyId ?? undefined });
  const used = providersData.data?.providers ?? [];
  const usesClaude = used.some((p) => p.slug === "anthropic");
  const claudeData = usePluginData<ClaudeUsage>("claude-usage", { companyId: companyId ?? undefined });
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

  // Claude: the worker reads the shared usage-exact.json, or refreshes it when 60 s old.
  const refreshClaude = claudeData.refresh;
  useTicker(Boolean(companyId) && usesClaude, () => {
    setNow(Date.now());
    refreshClaude();
  }, [companyId, refreshClaude], CLAUDE_TICK_MS);

  // Quota windows: Codex only. Each call of that route also polls the provider.
  const needed = used.map((p) => p.slug).filter((slug) => slug === "openai");
  const neededKey = needed.join(",");
  useTicker(Boolean(companyId) && needed.length > 0, () => {
    setNow(Date.now());
    void refresh(companyId as string, neededKey.split(","), false);
  }, [companyId, neededKey]);

  if (!companyId) return null;
  if (providersData.error) return <UsageLimitsView kind="error" message={providersData.error.message} />;
  const rows = buildRowViews(
    used,
    { data: claudeData.data ?? null, error: claudeData.error ? claudeData.error.message : null },
    quota,
    now,
  );
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
