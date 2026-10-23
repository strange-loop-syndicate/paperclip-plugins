import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { ALLOWED_USER_IDS, buildCommands, pluginRoot, type BangCommand } from "./commands.js";
import { runCommand, startDetached, type RunResult } from "./runner.js";
import { formatHelp, formatResult, label, parseComment } from "./handler.js";

export interface WorkerDeps {
  commands: BangCommand[];
  allowedUserIds: string[];
  run: (cmd: BangCommand) => Promise<RunResult>;
  startDetached: (cmd: BangCommand) => { pid: number | undefined };
}

const root = pluginRoot(import.meta.url);
const defaultDeps: WorkerDeps = {
  commands: buildCommands(root),
  allowedUserIds: ALLOWED_USER_IDS,
  run: runCommand,
  startDetached: (cmd) => startDetached(cmd, `${root}/detached-${cmd.name}.log`),
};

export function createPlugin(deps: WorkerDeps = defaultDeps) {
  /** Comment ids already handled; guards against duplicate event delivery. */
  const handled = new Set<string>();

  return definePlugin({
    async setup(ctx) {
      ctx.events.on("issue.comment.created", async (event) => {
        // Allowed users only. Agent comments and this plugin's own replies are ignored.
        if (event.actorType !== "user") return;
        const issueId = event.entityId;
        const payload = (event.payload ?? {}) as { commentId?: string };
        const commentId = payload.commentId;
        if (!issueId || !commentId || handled.has(commentId)) return;

        const comments = await ctx.issues.listComments(issueId, event.companyId);
        const comment = comments.find((c) => c.id === commentId);
        if (!comment || comment.authorAgentId || !comment.authorUserId) return;
        if (!deps.allowedUserIds.includes(comment.authorUserId)) return;

        const parsed = parseComment(comment.body, deps.commands);
        if (parsed.kind === "none") return;
        handled.add(commentId);

        const reply = (body: string) => ctx.issues.createComment(issueId, body, event.companyId);

        if (parsed.kind === "help") return void (await reply(formatHelp(deps.commands)));

        const cmd = parsed.command;
        ctx.logger.info("Running bang command", { command: cmd.name, userId: comment.authorUserId, issueId, commentId, actorId: event.actorId });

        if (cmd.detached) {
          await reply(`⏳ **${label(cmd)}** started. It runs in the background and does not post a result here.`);
          const { pid } = deps.startDetached(cmd);
          ctx.logger.info("Started detached bang command", { name: cmd.name, pid });
          return;
        }

        const result = await deps.run(cmd);
        await reply(formatResult(cmd, result));
      });
    },

    async onHealth() {
      return { status: "ok", message: `Shortcuts: ${defaultDeps.commands.map((c) => c.name).join(", ")}; shell for users ${defaultDeps.allowedUserIds.join(", ")}` };
    },
  });
}

const plugin = createPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
