import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createPlugin, type WorkerDeps } from "../src/worker.js";
import { fence, parseComment, truncate } from "../src/handler.js";
import { runCommand } from "../src/runner.js";
import type { BangCommand } from "../src/commands.js";

const COMPANY = "co_1";
const ISSUE = "iss_1";

const commands: BangCommand[] = [
  { name: "status", description: "health", argv: ["/bin/echo", "ok"], timeoutMs: 5_000 },
  { name: "restart", description: "restart", argv: ["/usr/bin/true"], timeoutMs: 5_000, detached: true },
];

function setup() {
  const ran: string[] = [];
  const detached: string[] = [];
  const deps: WorkerDeps = {
    commands,
    run: async (cmd) => {
      ran.push(cmd.name);
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
  return { harness, plugin, ran, detached };
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
    expect(manifest.capabilities).toEqual(["events.subscribe", "issue.comments.read", "issue.comments.create"]);
  });

  it("runs an allowlisted command for a user comment and replies", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "  !status \n", { user: "local-board" });
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
    await comment(h, "c1", "!status", { user: "u" });
    await h.harness.emit("issue.comment.created", { commentId: "c1" }, { entityId: ISSUE, companyId: COMPANY, actorType: "user" });
    expect(h.ran).toEqual(["status"]);
  });

  it("replies with the allowed list for an unknown name and runs nothing", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!rm-rf", { user: "u" });
    expect(h.ran).toEqual([]);
    const [r] = await replies(h);
    expect(r).toContain("Unknown command `!rm-rf`");
    expect(r).toContain("`!status`");
    expect(r).toContain("`!restart`");
  });

  it("refuses arguments", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!status; rm -rf /", { user: "u" });
    expect(h.ran).toEqual([]);
    const [r] = await replies(h);
    expect(r).toContain("takes no arguments");
  });

  it("ignores prose that starts with !", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!important please read", { user: "u" });
    await comment(h, "c2", "hello !status", { user: "u" });
    expect(h.ran).toEqual([]);
    expect(await replies(h)).toEqual([]);
  });

  it("replies first, then starts detached commands", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!restart", { user: "u" });
    expect(h.detached).toEqual(["restart"]);
    expect(h.ran).toEqual([]);
    expect((await replies(h))[0]).toContain("started");
  });
});

describe("parse and format", () => {
  it("parses only whole-comment commands", () => {
    expect(parseComment("!status", commands).kind).toBe("run");
    expect(parseComment("!STATUS", commands).kind).toBe("run");
    expect(parseComment("!nope", commands).kind).toBe("unknown");
    expect(parseComment("!status now", commands).kind).toBe("has-args");
    expect(parseComment("!status\n!restart", commands).kind).toBe("has-args");
    expect(parseComment("status", commands).kind).toBe("none");
    expect(parseComment("!$(id)", commands).kind).toBe("none");
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
});
