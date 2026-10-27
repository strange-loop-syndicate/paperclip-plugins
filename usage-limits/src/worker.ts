import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { defaultPaths, getClaudeUsage, newUsageState, type UsageDeps } from "./claude-usage.ts";
import { usedProviders } from "./mapping.ts";

const AGENT_PAGE_SIZE = 500;

/** Built per plugin instance; tests pass their own paths, fetch and clock. */
export function createPlugin(deps: UsageDeps = { paths: defaultPaths(), fetch: (...args) => fetch(...args), now: Date.now }) {
  const usageState = newUsageState();
  return definePlugin({
    async setup(ctx) {
      // Which quota providers the company's agents use.
      ctx.data.register("used-providers", async (params) => {
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        if (!companyId) return { providers: [] };
        const agents = await ctx.agents.list({ companyId, limit: AGENT_PAGE_SIZE });
        return { providers: usedProviders(agents) };
      });

      // Claude limits of the active account, from the Anthropic usage API
      // through the cache file the status line shares. Never returns the token.
      ctx.data.register("claude-usage", async () => getClaudeUsage(deps, usageState));
    },

    async onHealth() {
      return { status: "ok" };
    },
  });
}

const plugin = createPlugin();

export default plugin;
runWorker(plugin, import.meta.url);
