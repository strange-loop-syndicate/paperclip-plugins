import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs scripts/restart-paperclip.sh against a stub server in a temp folder, on a
// random port. The stub tree mirrors production: server → plugin worker → script.
const SCRIPT = fileURLToPath(new URL("../scripts/restart-paperclip.sh", import.meta.url));

// Stub `paperclipai run`: serves /api/health on the port in $ROOT/port and, like
// Paperclip, takes the next port when that one is busy.
const STUB_SERVER = `
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "../../../..");
const port = Number(fs.readFileSync(path.join(root, "port"), "utf8"));
process.on("SIGTERM", () => { if (!process.env.STUB_IGNORE_TERM) process.exit(0); });
if (fs.existsSync(path.join(root, "listen-in-child"))) {
  spawn(process.execPath, ["-e", "require('net').createServer().listen(" + port + ", '127.0.0.1')"],
    { detached: true, stdio: "ignore" }).unref();
  setInterval(() => {}, 1e6);
  return;
}
const server = http.createServer((req, res) => {
  res.writeHead(req.url === "/api/health" ? 200 : 404);
  res.end(JSON.stringify({ status: "ok", pid: process.pid }));
});
server.on("error", (e) => { if (e.code === "EADDRINUSE") server.listen(port + 1, "127.0.0.1"); });
server.listen(port, "127.0.0.1");
if (process.env.STUB_RESTART) {
  const env = { ...process.env };
  delete env.STUB_RESTART;
  spawn(process.execPath, [path.join(root, "worker.js"), process.env.STUB_RESTART], { env, stdio: "ignore" });
}
`;

// Stub plugin worker: records what the old lookup (plain pgrep -f) sees, then
// starts the script detached, as runner.ts startDetached does.
const STUB_WORKER = `
const fs = require("node:fs"), path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const root = __dirname;
const entryRe = path.join(root, "app/node_modules/paperclipai/dist/index.js").replace(/[.[\\]*^$+?(){}|\\\\]/g, "\\\\$&");
let plain = "";
try { plain = execFileSync("pgrep", ["-f", entryRe + " run"], { encoding: "utf8" }); } catch {}
fs.writeFileSync(path.join(root, "plain-pgrep.txt"), plain.trim());
const [file, ...args] = JSON.parse(process.argv[2]);
const fd = fs.openSync(path.join(root, "script-stdout.log"), "a");
spawn(file, args, { detached: true, stdio: ["ignore", fd, fd] }).unref();
setInterval(() => {}, 1e6);
`;

interface Ctx {
  root: string;
  port: number;
  entry: string;
  env: NodeJS.ProcessEnv;
  extraPids: number[];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const listeners = (port: number) => sh("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]).split("\n").filter(Boolean).map(Number);

function alive(pid: number): boolean {
  const st = sh("ps", ["-o", "stat=", "-p", String(pid)]);
  return st !== "" && !st.startsWith("Z");
}

/** Stub servers running from this test's folder. */
function servers(c: Ctx): number[] {
  return sh("ps", ["-axo", "pid=,args="])
    .split("\n")
    .filter((l) => l.includes(` ${c.entry} run`))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter(alive);
}

async function waitFor<T>(what: string, fn: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function restartLog(c: Ctx): string {
  const p = join(c.root, "restart-paperclip.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function startStub(c: Ctx, env: NodeJS.ProcessEnv = {}): number {
  const child = spawn(c.env.RESTART_PC_NODE!, [c.entry, "run"], {
    env: { ...c.env, ...env },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid!;
}

function runScript(c: Ctx, args: string[] = []): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", [SCRIPT, ...args], { env: c.env, stdio: "ignore" });
    child.on("close", (code) => resolve(code));
  });
}

describe.skipIf(process.platform !== "darwin")("restart-paperclip.sh", () => {
  let c: Ctx;

  beforeEach(async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "restart-pc-")));
    let port = await freePort();
    while (port === 3100 || port === 3099) port = await freePort();
    const entry = join(root, "app/node_modules/paperclipai/dist/index.js");
    mkdirSync(join(root, "app/node_modules/paperclipai/dist"), { recursive: true });
    mkdirSync(join(root, "patches"));
    writeFileSync(join(root, "package.json"), '{"type":"commonjs"}');
    writeFileSync(entry, STUB_SERVER);
    writeFileSync(join(root, "worker.js"), STUB_WORKER);
    writeFileSync(join(root, "patches/apply-all.mjs"), 'console.log("stub patches applied");');
    writeFileSync(join(root, "port"), String(port));
    c = {
      root,
      port,
      entry,
      extraPids: [],
      env: {
        PATH: process.env.PATH,
        RESTART_PC_ROOT: root,
        RESTART_PC_NODE: process.execPath,
        RESTART_PC_PORT: String(port),
        RESTART_PC_DELAY: "0",
        RESTART_PC_STOP_WAIT: "5",
        RESTART_PC_HEALTH_WAIT: "15",
      },
    };
  });

  afterEach(() => {
    const pids = sh("ps", ["-axo", "pid=,args="])
      .split("\n")
      .filter((l) => l.includes(c.root))
      .map((l) => Number(l.trim().split(/\s+/)[0]));
    for (const pid of [...pids, ...listeners(c.port), ...listeners(c.port + 1), ...c.extraPids]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(c.root, { recursive: true, force: true });
  });

  it("finds the server that is its ancestor, stops it, and leaves exactly one new server", async () => {
    const old = startStub(c, { STUB_RESTART: JSON.stringify(["/bin/sh", SCRIPT]) });
    const log = await waitFor("result line", () => /result: /.test(restartLog(c)) && restartLog(c));

    // The old lookup, run from below the server, does not see it.
    expect(readFileSync(join(c.root, "plain-pgrep.txt"), "utf8")).toBe("");
    expect(log).toContain(`stopping server pid(s): ${old}\n`);
    expect(log).toContain("result: ok");
    expect(alive(old)).toBe(false);
    const now = servers(c);
    expect(now).toHaveLength(1);
    expect(now[0]).not.toBe(old);
    expect(listeners(c.port)).toEqual(now);
    expect(listeners(c.port + 1)).toEqual([]);
  });

  it("dry run from below the server names it as an ancestor and changes nothing", async () => {
    const old = startStub(c, { STUB_RESTART: JSON.stringify(["/bin/sh", SCRIPT, "--dry-run"]) });
    const log = await waitFor("dry-run listener line", () => /listener pid/.test(restartLog(c)) && restartLog(c));

    expect(readFileSync(join(c.root, "plain-pgrep.txt"), "utf8")).toBe("");
    expect(log).toContain(`would stop server pid ${old} (ancestor of this script)`);
    expect(log).toContain(`:${c.port} listener pid(s): [${old}]`);
    expect(servers(c)).toEqual([old]);
  });

  it("refuses to start a server while something else holds the port", async () => {
    const blocker = spawn(process.execPath, ["-e", `require("net").createServer().listen(${c.port}, "127.0.0.1")`], {
      stdio: "ignore",
    });
    c.extraPids.push(blocker.pid!);
    await waitFor("blocker listening", () => listeners(c.port).includes(blocker.pid!));

    expect(await runScript(c)).toBe(1);
    const log = restartLog(c);
    expect(log).toContain(`result: FAILED: not starting a server: server pid(s) still running: [], :${c.port} listener pid(s): [${blocker.pid}]`);
    expect(log).not.toContain("starting server\n");
    expect(servers(c)).toEqual([]);
    expect(alive(blocker.pid!)).toBe(true);
  });

  it("stops every server, not only the first", async () => {
    const a = startStub(c);
    await waitFor("server a on the port", () => listeners(c.port).includes(a));
    const b = startStub(c);
    await waitFor("server b on the next port", () => listeners(c.port + 1).includes(b));

    expect(await runScript(c)).toBe(0);
    const log = restartLog(c);
    const stopped = log.match(/stopping server pid\(s\): (.*)\n/)![1].split(" ").map(Number);
    expect(stopped.sort()).toEqual([a, b].sort());
    expect(alive(a) || alive(b)).toBe(false);
    expect(servers(c)).toHaveLength(1);
    expect(listeners(c.port + 1)).toEqual([]);
  });

  it("sends SIGKILL to a server that ignores SIGTERM", async () => {
    c.env.RESTART_PC_STOP_WAIT = "1";
    const old = startStub(c, { STUB_IGNORE_TERM: "1" });
    await waitFor("server on the port", () => listeners(c.port).includes(old));

    expect(await runScript(c)).toBe(0);
    expect(restartLog(c)).toContain(`sending SIGKILL to: ${old}`);
    expect(alive(old)).toBe(false);
    expect(servers(c)).toHaveLength(1);
  });

  it("fails and stops the new server when another process owns the port", async () => {
    writeFileSync(join(c.root, "listen-in-child"), "");

    expect(await runScript(c)).toBe(1);
    const log = restartLog(c);
    expect(log).toMatch(/result: FAILED: :\d+ listener is \[\d+\], not the new server \d+; stopped the new server/);
    await waitFor("new server gone", () => servers(c).length === 0);
  });
});
