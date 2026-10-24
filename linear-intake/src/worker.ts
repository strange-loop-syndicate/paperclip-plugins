import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { parseConfig } from "./config.ts";
import { JOB_KEY, runIntake, type LinearUserCache } from "./intake.ts";

// Config is company-scoped and a scheduled job has no company context. The host
// replays each stored company config through onConfigChanged at worker start,
// so the worker binds to that company (single-tenant: one company per worker).
let boundCompanyId: string | null = null;
const linearUserIds: LinearUserCache = new Map();

const plugin = definePlugin({
  async setup(ctx) {
    boundCompanyId = null;
    linearUserIds.clear();

    ctx.jobs.register(JOB_KEY, async () => {
      const companyId = boundCompanyId;
      if (!companyId) {
        ctx.logger.warn("No company config yet; save the plugin config in a company to start intake");
        return;
      }
      const parsed = parseConfig(await ctx.config.get(companyId));
      if (!parsed.ok) {
        ctx.logger.error("Plugin config is invalid; intake skipped", { errors: parsed.errors });
        throw new Error(`Invalid config: ${parsed.errors.join("; ")}`);
      }
      const summary = await runIntake(ctx, companyId, parsed.config, linearUserIds);
      if (summary.created.length > 0 || summary.adopted.length > 0) {
        ctx.logger.info("Linear intake tick", { ...summary });
      }
    });
  },

  async onConfigChanged(_config, context) {
    if (context?.companyId) boundCompanyId = context.companyId;
    linearUserIds.clear();
  },

  async onValidateConfig(config) {
    const parsed = parseConfig(config);
    return parsed.ok ? { ok: true } : { ok: false, errors: parsed.errors };
  },

  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
