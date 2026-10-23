import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { usedProviders } from "./mapping.ts";

const AGENT_PAGE_SIZE = 500;

const plugin = definePlugin({
  async setup(ctx) {
    // Which quota providers the company's agents use. Quota windows themselves
    // come from the board-only costs route, which the UI calls directly.
    ctx.data.register("used-providers", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      if (!companyId) return { providers: [] };
      const agents = await ctx.agents.list({ companyId, limit: AGENT_PAGE_SIZE });
      return { providers: usedProviders(agents) };
    });
  },

  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
