import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createPlugin, type WorkerDeps } from "../src/worker.js";
import { fence, label, parseComment, truncate } from "../src/handler.js";
import { runCommand } from "../src/runner.js";
import type { BangCommand } from "../src/commands.js";
import { paragraph, storeBlocks, storeTyped } from "./editor.js";

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

describe("comment Markdown → typed command", () => {
  const shell = (body: string) => {
    const p = parseComment(body, commands);
    if (p.kind !== "run") throw new Error(`expected a command, got ${p.kind}`);
    return p.command.argv[2];
  };
  /** Type `!<command>` in the editor, store it, parse it back. */
  const roundTrip = (command: string) => shell(storeTyped(`!${command}`));

  it("runs the SLS-193 command as typed", () => {
    const stored = "!PAPERCLIP\\_COMPANY\\_ID\\=abc python3 -I /x/y.py";
    expect(storeTyped("!PAPERCLIP_COMPANY_ID=abc python3 -I /x/y.py")).toBe(stored);
    expect(shell(stored)).toBe("PAPERCLIP_COMPANY_ID=abc python3 -I /x/y.py");
  });

  const SYMBOLS = ["_", "=", "*", "$", "&", "|", ">", "<", ";", "'", '"', "#", "[", "]", "(", ")", "{", "}", "~", "!", "%", "^", "\\", "`", "-", "+", ".", ":", "@", "/", "?", ","];
  it.each(SYMBOLS)("keeps %s mid-line, doubled and at a line start", (s) => {
    const typed = `echo a${s}b ${s} ${s}${s}x ${s}[y](z)\n${s}line\n${s}${s}`;
    expect(roundTrip(typed)).toBe(typed);
  });

  it("keeps the editor's stored escapes for the risky symbols", () => {
    expect(storeTyped("!echo _ = * < ~ [ ` \\_")).toBe("!echo \\_ \\= \\* \\< \\~ \\[ \\` \\\\\\_");
    expect(roundTrip("echo _ = * < ~ [ ` \\_")).toBe("echo _ = * < ~ [ ` \\_");
  });

  it("keeps real backslashes", () => {
    expect(shell("!echo a\\\\b")).toBe("echo a\\b");
    expect(roundTrip("echo \\\\ \\n \\$HOME a\\")).toBe("echo \\\\ \\n \\$HOME a\\");
    expect(roundTrip("printf 'a\\tb\\n' | sed 's/\\(a\\)/\\1/'")).toBe("printf 'a\\tb\\n' | sed 's/\\(a\\)/\\1/'");
  });

  it("keeps chains, redirects, globs and substitutions", () => {
    for (const typed of [
      "cd /tmp && ls -la || echo fail; echo done",
      "cat < in.txt > out.txt 2>&1",
      "diff <(sort a) <(sort b)",
      "ls *.txt **/_x_*.md",
      'x=$(date +%s); echo "${x:-0}" ~/y',
      "grep -E '^a|b$' f | awk '{print $1}'",
      "echo <b>tag</b> <https://x.y> <a@b.co>",
      "echo &amp; &#39; &lt; &nbsp;",
      "python3 -c 'print(1 == 2, [1][0], {\"a\": 1})'",
    ]) {
      expect(roundTrip(typed)).toBe(typed);
    }
  });

  it("keeps multi-line commands and heredocs, one newline per Enter", () => {
    const heredoc = "cat <<'EOF' > /tmp/x\n# head_er\n- item *one*\n1. two\n> quote\n  indented\n\ttab\nEOF";
    expect(roundTrip(heredoc)).toBe(heredoc);
    expect(roundTrip("echo a\n\necho b")).toBe("echo a\n\necho b");
    expect(roundTrip("ls \\\n  -la")).toBe("ls \\\n  -la");
  });

  it("turns a hard break (Shift+Enter) into a newline", () => {
    const stored = storeBlocks([
      paragraph([{ type: "text", value: "!echo a \\" }, { type: "break" }, { type: "text", value: "b" }, { type: "break" }, { type: "text", value: "echo c" }]),
    ]);
    expect(shell(stored)).toBe("echo a \\\nb\necho c");
    expect(shell("!echo a  \necho b")).toBe("echo a\necho b");
  });

  it("turns an auto-linked URL back into the typed URL", () => {
    const url = "https://x.com/a_b?c=1&d=[2]";
    const stored = storeBlocks([
      paragraph([
        { type: "text", value: "!curl -s " },
        { type: "link", url, children: [{ type: "text", value: url }] },
        { type: "text", value: " | jq ." },
      ]),
    ]);
    expect(stored).toContain("](https://");
    expect(shell(stored)).toBe(`curl -s ${url} | jq .`);
    expect(shell('!open [www.x.com](https://www.x.com "t")')).toBe("open www.x.com");
  });

  it("keeps typed backticks that the editor turned into inline code", () => {
    const stored = storeBlocks([paragraph([{ type: "text", value: "!echo " }, { type: "inlineCode", value: "date +%_H" }])]);
    expect(stored).toBe("!echo `date +%_H`");
    expect(shell(stored)).toBe("echo `date +%_H`");
  });

  it("runs a fenced code block byte-for-byte", () => {
    const code = "echo a\\_b \\= &amp; [x](y)\n\nprintf '%s\\n' `pwd`";
    for (const fenceMarker of ["```", "~~~", "````"]) {
      expect(shell(`!\n\n${fenceMarker}bash\n${code}\n${fenceMarker}`)).toBe(code);
    }
    expect(shell(storeBlocks([paragraph([{ type: "text", value: "!" }]), { type: "code", lang: "txt", value: code }]))).toBe(code);
    expect(shell("!```sh\necho open")).toBe("echo open");
  });

  it("unescapes text around a code block and keeps the block as is", () => {
    const stored = storeBlocks([
      paragraph([{ type: "text", value: "!cd /tmp/a_b" }]),
      { type: "code", lang: "txt", value: "cat <<'EOF'\nx\\_y\n\nEOF" },
      paragraph([{ type: "text", value: "echo done_ok" }]),
    ]);
    expect(shell(stored)).toBe("cd /tmp/a_b\ncat <<'EOF'\nx\\_y\n\nEOF\necho done_ok");
  });

  it("runs one inline code span byte-for-byte", () => {
    expect(shell("!`PAPERCLIP\\_ID\\=1 env`")).toBe("PAPERCLIP\\_ID\\=1 env");
    expect(shell("!`` echo `id` ``")).toBe("echo `id`");
    expect(shell("!`status`")).toBe("status");
    expect(shell("!`a` and `b`")).toBe("`a` and `b`");
  });

  it("still matches images, help and shortcuts", () => {
    const kind = (t: string) => parseComment(t, commands).kind;
    expect(kind("![](/api/assets/x/content)")).toBe("image");
    expect(kind(storeTyped("!help"))).toBe("help");
    expect(parseComment(storeTyped("!status"), commands)).toEqual({ kind: "run", command: commands[0] });
    expect(kind("!&#x20;")).toBe("none");
    expect(kind("!```\n```")).toBe("none");
  });

  it("labels the reply with the unescaped command", async () => {
    const h = setup();
    await h.plugin.definition.setup(h.harness.ctx);
    await comment(h, "c1", "!PAPERCLIP\\_COMPANY\\_ID\\=abc env", { user: "owner" });
    expect(h.ran).toEqual(["PAPERCLIP_COMPANY_ID=abc env"]);
    expect((await replies(h))[0]).toContain("`!PAPERCLIP_COMPANY_ID=abc env`");
  });

  it("runs the SLS-193 command shape through zsh with exit 0", async () => {
    const p = parseComment(storeTyped("!PAPERCLIP_COMPANY_ID=a48292a1-x /usr/bin/printenv PAPERCLIP_COMPANY_ID"), commands);
    if (p.kind !== "run") throw new Error(p.kind);
    expect(p.command.argv.slice(0, 2)).toEqual(["/bin/zsh", "-lc"]);
    const r = await runCommand({ ...p.command, cwd: undefined });
    expect(r.output.trim()).toBe("a48292a1-x");
    expect(r.exitCode).toBe(0);
  });

  it("passes every corpus symbol to zsh unchanged", async () => {
    const literal = "a_b=c*d$e&f|g>h<i;j\"k#l[m]n(o)p{q}r~s!t%u^v\\w`x";
    const p = parseComment(storeTyped(`!cat <<'EOF'\n${literal}\nEOF`), commands);
    if (p.kind !== "run") throw new Error(p.kind);
    const r = await runCommand({ ...p.command, cwd: undefined });
    expect(r.output).toBe(`${literal}\n`);
    expect(r.exitCode).toBe(0);
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
