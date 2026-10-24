// End-to-end: spawn bin/claude/claude and bin/codex/codex the way the
// Paperclip adapter does (args + prompt on stdin), with a fake CLI behind them.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { nestingDepth, readAllStdin } from "../src/wrapper/main.js";
import { readWrapperConfig, recallForRun } from "../src/wrapper/recall.js";
import { deadUrl, seedMemory, startFakeServer } from "./helpers/fake-servers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLI = join(ROOT, "test/helpers/fake-cli.js");
const A = "company-a";
const B = "company-b";
const PROMPT = "You are agent-1. Continue your Paperclip work.";
const INSTRUCTIONS = "# Agent instructions\nBe careful.";

let server;
let tmp;
let SAFE_PATH;

function runWrapper(cli, args, { env = {}, stdin = PROMPT } = {}) {
  return new Promise((resolve) => {
    const out = join(tmp, `out-${Math.random().toString(36).slice(2)}.json`);
    const spawnedAt = Date.now();
    const child = spawn(join(ROOT, "bin", cli, cli), args, {
      env: {
        PATH: SAFE_PATH,
        MEMOS_REAL_COMMAND: FAKE_CLI,
        FAKE_CLI_OUT: out,
        MEMOS_BASE_URL: server.url,
        MEMOS_RECALL_TIMEOUT_MS: "1000",
        PAPERCLIP_API_URL: server.url,
        PAPERCLIP_API_KEY: "run-jwt",
        PAPERCLIP_COMPANY_ID: A,
        PAPERCLIP_AGENT_ID: "agent-1",
        PAPERCLIP_TASK_ID: "iss-1",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", async (code) => {
      let received = null;
      try {
        received = JSON.parse(await readFile(out, "utf8"));
      } catch {}
      resolve({ code, stdout, stderr, received, elapsedMs: Date.now() - spawnedAt });
    });
    child.stdin.end(stdin);
  });
}

async function instructionsFile() {
  const path = join(tmp, "instructions.md");
  await writeFile(path, INSTRUCTIONS);
  return path;
}

const claudeFreshArgs = (file) => ["--print", "--output-format", "stream-json", "--verbose", "--append-system-prompt-file", file, "--add-dir", "/tmp"];

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "memos-wrapper-test-"));
  const nodeBin = await mkdtemp(join(tmp, "node-bin-"));
  await symlink(process.execPath, join(nodeBin, "node"));
  SAFE_PATH = `${nodeBin}:/usr/bin:/bin`;
  server = await startFakeServer({
    issues: { "iss-1": { id: "iss-1", companyId: A, projectId: "p1", identifier: "SLS-1", title: "Deploy the web app", description: "Ship it" } },
  });
});
after(async () => {
  await server.close();
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  server.state.mode = "ok";
  server.state.delayMs = 0;
  server.state.issueMode = "ok";
  server.state.store.length = 0;
  server.state.requests.length = 0;
  server.state.sharedScopes = {};
  server.state.sharingMode = "ok";
  seedMemory(server.state, { companyId: A, projectId: "p1", content: "Deploys go through the DevOps agent", info: { kind: "lesson", issueIdentifier: "SLS-0" } });
  seedMemory(server.state, { companyId: A, projectId: "p2", content: "Other project memory" });
  seedMemory(server.state, { companyId: B, projectId: "p1", content: "Company B memory" });
});

describe("pre-prompt recall wrapper: ordering", () => {
  it("claude fresh session: recall completes before the CLI starts, and the memory is in front of the stdin prompt", async () => {
    server.state.delayMs = 300; // make the ordering observable
    const file = await instructionsFile();
    const args = claudeFreshArgs(file);
    const r = await runWrapper("claude", args);
    assert.equal(r.code, 0, r.stderr);
    const search = server.memosRequests().find((q) => q.path === "/product/search");
    assert.ok(search?.respondedAt, "MemOS search was answered");
    assert.ok(search.respondedAt <= r.received.startedAt, `search answered at ${search.respondedAt}, CLI started at ${r.received.startedAt}`);
    assert.match(r.received.stdin, /^<paperclip-memory>[\s\S]*\[lesson\] Deploys go through the DevOps agent \(SLS-0\)[\s\S]*<\/paperclip-memory>\n\nYou are agent-1/);
    // Memories are agent-written text: never in the system prompt.
    assert.deepEqual(r.received.args, args, "adapter args unchanged");
    assert.equal(r.received.systemPromptFile, INSTRUCTIONS, "system prompt carries no memories");
    assert.match(r.stderr, /\[paperclip-memos\] recall recalled 1; placement=stdin/);
    assert.match(r.stdout, /"type":"result"/, "CLI stdout passes through untouched");
  });

  it("claude resumed session (no instructions flag): memory goes in front of the stdin prompt", async () => {
    const r = await runWrapper("claude", ["--print", "--output-format", "stream-json", "--resume", "sess-1"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.received.stdin.startsWith("<paperclip-memory>"));
    assert.ok(r.received.stdin.endsWith(PROMPT));
  });

  it("codex: memory goes in front of the stdin prompt, before the CLI starts", async () => {
    server.state.delayMs = 200;
    const r = await runWrapper("codex", ["exec", "--json", "-"]);
    assert.equal(r.code, 0, r.stderr);
    const search = server.memosRequests().find((q) => q.path === "/product/search");
    assert.ok(search.respondedAt <= r.received.startedAt);
    assert.match(r.received.stdin, /^<paperclip-memory>[\s\S]*Deploys go through the DevOps agent[\s\S]*<\/paperclip-memory>\n\nYou are agent-1/);
    assert.deepEqual(r.received.args, ["exec", "--json", "-"]);
  });

  it("recall uses the run's company + project scope and the issue text as the query", async () => {
    await runWrapper("claude", ["--print"]);
    const searches = server.memosRequests().filter((q) => q.path === "/product/search");
    assert.deepEqual(searches.map((s) => s.body.mem_cube_id), [`paperclip-${A}-p1`]);
    assert.match(searches[0].body.query, /SLS-1\nDeploy the web app\nShip it/);
    const issueLookup = server.state.requests.find((q) => q.path === "/api/issues/iss-1");
    assert.equal(issueLookup.headers.authorization, "Bearer run-jwt");
  });

  it("reads sharing from the plugin route and labels shared memories with their project", async () => {
    server.state.sharedScopes.p1 = [{ projectId: "p2", projectName: "Ops" }];
    const r = await runWrapper("codex", ["exec", "-"]);
    assert.match(r.received.stdin, /Other project memory \(shared from project "Ops"\)/);
    assert.doesNotMatch(r.received.stdin, /Company B memory/);
    const lookup = server.state.requests.find((q) => q.path.startsWith("/api/plugins/"));
    assert.equal(lookup.path, "/api/plugins/sls.memos-memory/api/recall-scopes?projectId=p1");
    assert.equal(lookup.headers.authorization, "Bearer run-jwt");
    const searches = server.memosRequests().filter((q) => q.path === "/product/search");
    assert.deepEqual(searches.map((s) => s.body.user_id), [`paperclip-${A}`, `paperclip-${A}`]);
  });

  it("ignores the retired MEMOS_SHARED_SCOPES env", async () => {
    const shared = JSON.stringify([{ companyId: A, projectId: "p2" }]);
    const r = await runWrapper("codex", ["exec", "-"], { env: { MEMOS_SHARED_SCOPES: shared } });
    assert.doesNotMatch(r.received.stdin, /Other project memory/);
  });

  it("a failing sharing lookup recalls the own project only, and still starts the CLI", async () => {
    server.state.sharedScopes.p1 = [{ projectId: "p2", projectName: "Ops" }];
    server.state.sharingMode = "error500";
    const r = await runWrapper("claude", ["--print"]);
    assert.match(r.received.stdin, /Deploys go through the DevOps agent/);
    assert.doesNotMatch(r.received.stdin, /Other project memory/);
  });

});

describe("pre-prompt recall wrapper: fails open", () => {
  it("a stdin read error resolves with the bytes read so far instead of rejecting", async () => {
    const stream = new PassThrough();
    const pending = readAllStdin(stream);
    stream.write("partial prompt");
    stream.destroy(new Error("EIO"));
    const { text, error } = await pending;
    assert.equal(text, "partial prompt");
    assert.equal(error.message, "EIO");
  });

  const cases = [
    ["MemOS down", async () => ({ MEMOS_BASE_URL: await deadUrl() })],
    ["MemOS returns 500", async () => ((server.state.mode = "error500"), {})],
    ["MemOS slow (5s) with a 500ms budget", async () => ((server.state.mode = "slow"), { MEMOS_RECALL_TIMEOUT_MS: "500" })],
    ["Paperclip issue lookup hangs, with a 500ms budget", async () => ((server.state.issueMode = "hang"), { MEMOS_RECALL_TIMEOUT_MS: "500" })],
    ["Paperclip issue lookup fails", async () => ({ PAPERCLIP_TASK_ID: "missing" })],
    ["issue belongs to another company", async () => ({ PAPERCLIP_COMPANY_ID: B })],
    ["MemOS not configured", async () => ({ MEMOS_BASE_URL: "" })],
  ];
  const clis = [
    ["claude", async () => claudeFreshArgs(await instructionsFile())],
    ["codex", async () => ["exec", "--json", "-"]],
  ];
  for (const [cli, argsFor] of clis) {
    for (const [name, envFor] of cases) {
      it(`${cli}, ${name}: the CLI still starts promptly with the original args and prompt`, async () => {
        const args = await argsFor();
        const r = await runWrapper(cli, args, { env: await envFor() });
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(r.received.args, args);
        if (cli === "claude") assert.equal(r.received.systemPromptFile, INSTRUCTIONS);
        assert.equal(r.received.stdin, PROMPT);
        assert.ok(r.elapsedMs < 2000, `took ${r.elapsedMs}ms`);
        assert.match(r.stderr, /\[paperclip-memos\] recall /);
      });
    }
  }

  it("defaults the recall budget to 3 s and caps a larger setting at 3 s", () => {
    assert.equal(readWrapperConfig({}).timeoutMs, 3000);
    assert.equal(readWrapperConfig({ MEMOS_RECALL_TIMEOUT_MS: "30000" }).timeoutMs, 3000);
    assert.equal(readWrapperConfig({ MEMOS_RECALL_TIMEOUT_MS: "500" }).timeoutMs, 500);
  });

  it("the recall budget counts from wrapper start, not from the first lookup", async () => {
    server.state.issueMode = "hang";
    const env = { MEMOS_BASE_URL: server.url, MEMOS_RECALL_TIMEOUT_MS: "1000", PAPERCLIP_API_URL: server.url, PAPERCLIP_COMPANY_ID: A, PAPERCLIP_TASK_ID: "iss-1" };
    const t0 = Date.now();
    const r = await recallForRun({ env, startedAt: t0 - 800 });
    assert.equal(r.block, "");
    assert.ok(Date.now() - t0 < 600, `took ${Date.now() - t0}ms of a 200ms remainder`);
  });

  it("a 30 s budget typo still starts the CLI within about 3 s when MemOS hangs", async () => {
    server.state.mode = "slow"; // answers after 5 s
    const r = await runWrapper("codex", ["exec", "-"], { env: { MEMOS_RECALL_TIMEOUT_MS: "30000" } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.received.stdin, PROMPT);
    assert.ok(r.elapsedMs < 4500, `took ${r.elapsedMs}ms`);
  });
});

describe("pre-prompt recall wrapper: the CLI's own error comes first on stderr", () => {
  for (const [cli, args] of [
    ["claude", ["--print", "-"]],
    ["codex", ["exec", "--json", "-"]],
  ]) {
    it(`${cli}: a failing CLI's stderr line is the first line, the wrapper's lines follow`, async () => {
      const r = await runWrapper(cli, args, {
        env: { MEMOS_BASE_URL: await deadUrl(), FAKE_CLI_EXIT: "1", FAKE_CLI_STDERR: "Error: Invalid API key - please run /login" },
      });
      assert.equal(r.code, 1);
      const lines = r.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      assert.equal(lines[0], "Error: Invalid API key - please run /login");
      assert.ok(lines.slice(1).some((l) => l.startsWith("[paperclip-memos] recall ")), r.stderr);
    });
  }
});

describe("pre-prompt recall wrapper: transparency", () => {
  it("passes --version probes straight through without recall", async () => {
    const r = await runWrapper("claude", ["--version"], { stdin: "" });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /9\.9\.9 \(fake\)/);
    assert.equal(server.state.requests.length, 0);
  });

  it("propagates the CLI exit code", async () => {
    const r = await runWrapper("codex", ["exec", "-"], { env: { FAKE_CLI_EXIT: "3" } });
    assert.equal(r.code, 3);
  });

  it("finds the real CLI on PATH, skipping itself", async () => {
    const binDir = await mkdtemp(join(tmp, "bin-"));
    const realClaude = join(binDir, "claude");
    await writeFile(realClaude, `#!/bin/sh\nexec node ${JSON.stringify(FAKE_CLI)} "$@"\n`, { mode: 0o755 });
    const r = await runWrapper("claude", ["--version"], {
      stdin: "",
      env: { MEMOS_REAL_COMMAND: "", PATH: `${join(ROOT, "bin", "claude")}:${binDir}:${SAFE_PATH}` },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /9\.9\.9 \(fake\)/);
  });
});

describe("pre-prompt recall wrapper: review fixes", () => {
  it("does not hand MemOS settings to the agent CLI, and marks the nesting depth", async () => {
    const r = await runWrapper("claude", ["--print"], { env: { MEMOS_API_KEY: "secret-token", MEMOS_SHARED_SCOPES: "[]" } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.received.memosEnvKeys, []);
    assert.match(r.received.wrappedDepth, /^\d+:1$/);
  });

  it("stops a wrapper-calls-wrapper loop instead of recursing forever", async () => {
    const r = await runWrapper("claude", ["--print"], { env: { MEMOS_REAL_COMMAND: join(ROOT, "bin", "claude", "claude") } });
    assert.equal(r.code, 127);
    assert.match(r.stderr, /resolves to this wrapper/);
  });

  it("a nesting marker inherited from a non-parent process does not skip recall", async () => {
    const r = await runWrapper("claude", ["--print"], { env: { PAPERCLIP_MEMOS_WRAPPED: "1:1" } });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.received.stdin.startsWith("<paperclip-memory>"));
    assert.match(r.received.wrappedDepth, /^\d+:1$/);
  });

  it("nesting depth counts only when the marker names the direct parent", () => {
    assert.equal(nestingDepth("4242:2", 4242), 2);
    assert.equal(nestingDepth("4242:2", 1), 0);
    assert.equal(nestingDepth("garbage", 4242), 0);
    assert.equal(nestingDepth(undefined, 4242), 0);
  });

  it("reports a child killed by a signal Node ignores (SIGUSR1) as 128+n, not 0", async () => {
    const script = join(tmp, "usr1-cli.sh");
    await writeFile(script, "#!/bin/sh\ncat >/dev/null\nkill -USR1 $$\n", { mode: 0o755 });
    const r = await runWrapper("codex", ["exec", "-"], { env: { MEMOS_REAL_COMMAND: script } });
    assert.equal(r.code, 128 + osConstants.signals.SIGUSR1);
    assert.doesNotMatch(r.stderr, /Debugger listening/);
  });

  for (const [detached, groupKill, label] of [
    [true, true, "process-group kill, as Paperclip does"],
    [false, false, "direct kill of a wrapper started from a shell"],
  ]) {
    it(`child receives SIGTERM exactly once: ${label}`, async () => {
      const out = join(tmp, `term-${detached}-${groupKill}.json`);
      const child = spawn(join(ROOT, "bin", "codex", "codex"), ["exec", "-"], {
        detached,
        stdio: ["pipe", "ignore", "pipe"],
        env: { PATH: SAFE_PATH, MEMOS_REAL_COMMAND: join(ROOT, "test/helpers/term-counter.js"), FAKE_CLI_OUT: out },
      });
      child.stdin.end(PROMPT);
      const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
      for (let i = 0; i < 100; i++) {
        try {
          await readFile(`${out}.ready`);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      if (groupKill) process.kill(-child.pid, "SIGTERM");
      else process.kill(child.pid, "SIGTERM");
      const { code } = await exited;
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(await readFile(out, "utf8")), { sigterms: 1 });
    });
  }
});
