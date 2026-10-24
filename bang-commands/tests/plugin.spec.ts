import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createPlugin, type WorkerDeps } from "../src/worker.js";
import { fence, label, parseComment, truncate } from "../src/handler.js";
import { runCommand } from "../src/runner.js";
import { detachedLogPath, pluginRoot, type BangCommand } from "../src/commands.js";

const COMPANY = "co_1";
const ISSUE = "iss_1";

const commands: BangCommand[] = [
  { name: "status", description: "health", argv: ["/bin/echo", "ok"], timeoutMs: 5_000 },
  { name: "restart", description: "restart", argv: ["/usr/bin/true"], timeoutMs: 5_000, detached: true },
];

function setup() {
  const ran: string[] = [];
  const argvs: string[][] = [];
  const detached: string[] = [];
  const deps: WorkerDeps = {
    commands,
    allowedUserIds: ["owner"],
    run: async (cmd) => {
      ran.push(cmd.name);
      argvs.push(cmd.argv);
      return { exitCode: 0, signal: null, timedOut: false, durationMs: 12, output: "ok\n" };
    },
    startDetached: (cmd) => {
      detached.push(cmd.name);
      return { pid: 1 };
    },
  };
  const harness = createTestHarness({ manifest });
  harness.seed({ issues: [{ id: ISSUE, companyId: COMPANY, status: "in_progress", title: "t" } as never] });
  const plugin = createPlugin(deps);
  const wakes = vi.spyOn(harness.ctx.issues, "requestWakeup");
  return { harness, plugin, ran, argvs, detached, wakes };
}

async function comment(
  h: ReturnType<typeof setup>,
  id: string,
  body: string,
  author: { user?: string; agent?: string },
  actorType: "user" | "agent" | "plugin" = author.agent ? "agent" : "user",
) {
  h.harness.seed({
    issueComments: [
      {
        id,
        companyId: COMPANY,
        issueId: ISSUE,
        authorAgentId: author.agent ?? null,
        authorUserId: author.user ?? null,
        body,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
    ],
  });
  await h.harness.emit(
    "issue.comment.created",
    { commentId: id },
    { entityId: ISSUE, entityType: "issue", companyId: COMPANY, actorType, actorId: author.user ?? author.agent },
  );
}

async function replies(h: ReturnType<typeof setup>) {
  const all = await h.harness.ctx.issues.listComments(ISSUE, COMPANY);
  return all.filter((c) => !c.authorUserId && !c.authorAgentId).map((c) => c.body);
}

describe("bang commands", () => {
  it("declares only the capabilities it uses", () => {
    expect(manifest.capabilities).toEqual(["events.subscribe", "issue.comments.read", "issue.comments.create", "issues.wakeup"]);
  });

  it("runs an allowlisted command for a user comment and replies", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "  !status \n", { user: "owner" });
    expect(h.ran).toEqual(["status"]);
    const r = await replies(h);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("`!status`");
    expect(r[0]).toContain("exit 0");
    expect(r[0]).toContain("12 ms");
  });

  it("ignores agent comments", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!status", { agent: "agent_1" });
    expect(h.ran).toEqual([]);
    expect(await replies(h)).toEqual([]);
  });

  it("ignores plugin-authored comments even without an agent id", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!status", {}, "plugin");
    expect(h.ran).toEqual([]);
  });

  it("handles each comment once", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!status", { user: "owner" });
    await h.harness.emit("issue.comment.created", { commentId: "c1" }, { entityId: ISSUE, companyId: COMPANY, actorType: "user" });
    expect(h.ran).toEqual(["status"]);
  });

  it("runs any other text in a shell", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!ls -la | head -3", { user: "owner" });
    await comment(h, "c2", "!status; rm -rf /tmp/x", { user: "owner" });
    expect(h.ran).toEqual(["ls -la | head -3", "status; rm -rf /tmp/x"]);
    expect(h.argvs[0]).toEqual(["/bin/zsh", "-lc", "ls -la | head -3"]);
    expect((await replies(h))[0]).toContain("`!ls -la | head -3`");
  });

  it("ignores users not on the allowed list", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!status", { user: "someone-else" });
    await comment(h, "c2", "!id", { user: "someone-else" });
    expect(h.ran).toEqual([]);
    expect(await replies(h)).toEqual([]);
  });

  it("replies to !help with the shortcuts and runs nothing", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!help", { user: "owner" });
    expect(h.ran).toEqual([]);
    const [r] = await replies(h);
    expect(r).toContain("`!status`");
    expect(r).toContain("runs in a shell");
  });

  it("ignores comments that do not start with !", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "hello !status", { user: "owner" });
    await comment(h, "c2", "!", { user: "owner" });
    expect(h.ran).toEqual([]);
    expect(await replies(h)).toEqual([]);
  });

  it("runs nothing for an owner comment that starts with a pasted image", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "![](/api/attachments/x/content)\n\nlook at this", { user: "owner" });
    expect(h.ran).toEqual([]);
    expect(h.detached).toEqual([]);
    expect(await replies(h)).toEqual([]);
  });

  it("replies first, then starts detached commands", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!restart", { user: "owner" });
    expect(h.detached).toEqual(["restart"]);
    expect(h.ran).toEqual([]);
    expect((await replies(h))[0]).toContain("started");
  });
});

describe("waking the assignee", () => {
  it("wakes the assignee once, after the reply is posted", async () => {
    const h = setup();
    h.harness.seed({ issues: [{ id: ISSUE, companyId: COMPANY, status: "in_progress", title: "t", assigneeAgentId: "agent_1" } as never] });
    await h.plugin.definition.setup(h.harness.ctx);
    let repliesAtWake: string[] = [];
    h.wakes.mockImplementation(async () => {
      repliesAtWake = await replies(h);
      return { queued: true, runId: "run_1" };
    });
    await comment(h, "c1", "!status", { user: "owner" });
    expect(h.wakes).toHaveBeenCalledTimes(1);
    expect(h.wakes).toHaveBeenCalledWith(ISSUE, COMPANY, { reason: "bang_command_result", idempotencyKey: "bang-commands:c1" });
    expect(repliesAtWake).toHaveLength(1);
  });

  it("still replies when there is no assignee to wake", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!status", { user: "owner" });
    expect(h.wakes).toHaveBeenCalledTimes(1);
    expect(await replies(h)).toHaveLength(1);
  });

  it("wakes the assignee once for an owner comment that starts with a pasted image", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "![](/api/attachments/x/content)\n\nlook at this", { user: "owner" });
    expect(h.wakes).toHaveBeenCalledTimes(1);
    expect(h.wakes).toHaveBeenCalledWith(ISSUE, COMPANY, { reason: "bang_image_comment", idempotencyKey: "bang-commands:c1" });
    expect(h.ran).toEqual([]);
    expect(await replies(h)).toEqual([]);
  });

  it("does not wake for an image comment from a user not on the allowed list", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "![](/api/attachments/x/content)", { user: "someone-else" });
    expect(h.wakes).not.toHaveBeenCalled();
  });

  it("does not wake for !help, detached commands or ignored comments", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!help", { user: "owner" });
    await comment(h, "c2", "!restart", { user: "owner" });
    await comment(h, "c3", "!status", { agent: "agent_1" });
    await comment(h, "c4", "hello", { user: "owner" });
    expect(h.wakes).not.toHaveBeenCalled();
  });
});

describe("parse and format", () => {
  it("parses shortcuts, help and shell text", () => {
    const run = (t: string) => {
      const p = parseComment(t, commands);
      return p.kind === "run" ? p.command : p.kind;
    };
    expect(run("!status")).toBe(commands[0]);
    expect(run("!STATUS")).toBe(commands[0]);
    expect(run("! status ")).toBe(commands[0]);
    expect(run("!help")).toBe("help");
    expect(run("status")).toBe("none");
    expect(run("!")).toBe("none");
    expect((run("!status now") as BangCommand).argv).toEqual(["/bin/zsh", "-lc", "status now"]);
    expect((run("!echo a\necho b") as BangCommand).argv[2]).toBe("echo a\necho b");
  });

  it("parses comments that start with a markdown image as image", () => {
    const kind = (t: string) => parseComment(t, commands).kind;
    expect(kind("![](/api/attachments/x/content) text")).toBe("image");
    expect(kind("![alt](url)")).toBe("image");
    expect(kind("  ![](/api/attachments/x/content)\n\nsee the screenshot")).toBe("image");
    expect(kind("!status")).toBe("run");
    expect(kind("!help")).toBe("help");
    expect((parseComment("!ls -la", commands) as { command: BangCommand }).command.argv).toEqual([
      "/bin/zsh",
      "-lc",
      "ls -la",
    ]);
  });

  it("labels long and multi-line shell commands", () => {
    const cmd = (name: string) => ({ ...commands[0], name });
    expect(label(cmd("echo a\necho b"))).toBe("`!echo a …`");
    expect(label(cmd("x".repeat(100)))).toContain("…");
    expect(label(cmd("echo `id`"))).toBe("`` !echo `id` ``");
  });

  it("keeps the tail when truncating", () => {
    const out = truncate("a".repeat(10) + "END", 5);
    expect(out.endsWith("aaEND")).toBe(true);
    expect(out).toContain("8 earlier characters cut");
  });

  it("uses a fence longer than any backtick run in the output", () => {
    expect(fence("x ``` y").startsWith("````text")).toBe(true);
  });
});

describe("runner", () => {
  it("captures exit code and output", async () => {
    const r = await runCommand({ name: "t", description: "", argv: ["/bin/sh", "-c", "echo hi; echo err >&2; exit 3"], timeoutMs: 5_000 });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("hi");
    expect(r.output).toContain("err");
    expect(r.timedOut).toBe(false);
  });

  it("kills a command at its timeout", async () => {
    const r = await runCommand({ name: "t", description: "", argv: ["/bin/sleep", "10"], timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(3_000);
  });

  it("reports a missing executable", async () => {
    const r = await runCommand({ name: "t", description: "", argv: ["/nonexistent/bin"], timeoutMs: 1_000 });
    expect(r.error).toBeTruthy();
  });

  it("logs detached commands next to the server log, outside the plugin folder", () => {
    const root = pluginRoot("file:///Users/claude/work/paperclip-plugins-repo/bang-commands/dist/worker.js");
    const log = detachedLogPath("restart-paperclip");
    expect(log).toBe("/Users/claude/work/paperclip/detached-restart-paperclip.log");
    expect(log.startsWith(`${root}/`)).toBe(false);
  });
});
