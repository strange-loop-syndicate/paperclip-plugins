import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { buildCommands, pluginRoot, type BangCommand } from "./commands.js";
import { runCommand, startDetached, type RunResult } from "./runner.js";
import { formatHasArgs, formatResult, formatUnknown, parseComment } from "./handler.js";

export interface WorkerDeps {
  commands: BangCommand[];
  run: (cmd: BangCommand) => Promise<RunResult>;
  startDetached: (cmd: BangCommand) => { pid: number | undefined };
}

const root = pluginRoot(import.meta.url);
const defaultDeps: WorkerDeps = {
  commands: buildCommands(root),
  run: runCommand,
  startDetached: (cmd) => startDetached(cmd, `${root}/detached-${cmd.name}.log`),
};

export function createPlugin(deps: WorkerDeps = defaultDeps) {
  /** Comment ids already handled; guards against duplicate event delivery. */
  const handled = new Set<string>();

  return definePlugin({
    async setup(ctx) {
      ctx.events.on("issue.comment.created", async (event) => {
        // Users only. Agent comments and this plugin's own replies are ignored.
        if (event.actorType !== "user") return;
        const issueId = event.entityId;
        const payload = (event.payload ?? {}) as { commentId?: string };
        const commentId = payload.commentId;
        if (!issueId || !commentId || handled.has(commentId)) return;

        const comments = await ctx.issues.listComments(issueId, event.companyId);
        const comment = comments.find((c) => c.id === commentId);
        if (!comment || comment.authorAgentId || !comment.authorUserId) return;

        const parsed = parseComment(comment.body, deps.commands);
        if (parsed.kind === "none") return;
        handled.add(commentId);

        const reply = (body: string) => ctx.issues.createComment(issueId, body, event.companyId);

        if (parsed.kind === "unknown") return void (await reply(formatUnknown(parsed.name, deps.commands)));
        if (parsed.kind === "has-args") return void (await reply(formatHasArgs(parsed.command, deps.commands)));

        const cmd = parsed.command;
        ctx.logger.info("Running bang command", { name: cmd.name, issueId, commentId, actorId: event.actorId });

        if (cmd.detached) {
          await reply(`⏳ **\`!${cmd.name}\`** started. It runs in the background and does not post a result here.`);
          const { pid } = deps.startDetached(cmd);
          ctx.logger.info("Started detached bang command", { name: cmd.name, pid });
          return;
        }

        const result = await deps.run(cmd);
        await reply(formatResult(cmd, result));
      });
    },

    async onHealth() {
      return { status: "ok", message: `Bang commands: ${defaultDeps.commands.map((c) => c.name).join(", ")}` };
    },
  });
}

const plugin = createPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
