// Adapter command wrapper. Configure the claude_local / codex_local adapter
// `command` to bin/claude/claude or bin/codex/codex. For an agent run it reads
// the prompt from stdin, recalls memories (hard deadline), injects them, and
// only then starts the real CLI. Probes (--version, --help) pass straight through.
//
// The wrapper's own diagnostics are held back and written to stderr only after
// the CLI exits: both adapters report the FIRST stderr line as the run error,
// and that must be the CLI's line, not ours.

import { execFile, spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { injectMemoryBlock, isAgentRun } from "./inject.js";
import { recallForRun } from "./recall.js";

const LOG_PREFIX = "[paperclip-memos]";
const DEPTH_ENV = "PAPERCLIP_MEMOS_WRAPPED";
const MAX_DEPTH = 3;

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The real CLI: MEMOS_REAL_COMMAND, else the first `cli` on PATH that is not this wrapper. */
export function resolveRealCommand({ cli, env, wrapperPath }) {
  if (env.MEMOS_REAL_COMMAND) return env.MEMOS_REAL_COMMAND;
  const self = safeRealpath(wrapperPath);
  const selfDir = dirname(self);
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cli);
    if (!isExecutable(candidate)) continue;
    const real = safeRealpath(candidate);
    if (real === self || dirname(real) === selfDir) continue;
    return candidate;
  }
  throw new Error(`cannot find the real ${cli} on PATH; set MEMOS_REAL_COMMAND`);
}

/**
 * The agent CLI gets the adapter's env minus MemOS settings (agents have a
 * shell; they should not get the MemOS URL or token handed to them), plus a
 * "<wrapper pid>:<depth>" marker that stops wrapper-calls-wrapper loops.
 */
export function childEnv(env, depth, pid = process.pid) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("MEMOS_")) continue;
    out[k] = v;
  }
  out[DEPTH_ENV] = `${pid}:${depth + 1}`;
  return out;
}

/**
 * Nesting depth. A marker counts only when our direct parent is the wrapper
 * that set it, so a marker inherited by unrelated descendants of the agent
 * (e.g. a Paperclip server started inside an agent session) is ignored.
 */
export function nestingDepth(marker, ppid = process.ppid) {
  const m = /^(\d+):(\d+)$/.exec(marker ?? "");
  if (!m || Number(m[1]) !== ppid) return 0;
  return Number(m[2]);
}

/**
 * Resolves true when this process leads its own process group (how Paperclip
 * spawns adapters), null when it cannot tell. Asynchronous, so it runs while
 * stdin is read and recall runs, not after them.
 */
function probeProcessGroupLeader() {
  if (process.platform === "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      execFile("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 1000 }, (err, stdout) => {
        const pgid = Number.parseInt(String(stdout ?? "").trim(), 10);
        resolve(!err && Number.isFinite(pgid) ? pgid === process.pid : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Never rejects: a read error resolves with the bytes read so far and the
 * error, so the CLI still starts (fail open) with what the adapter sent.
 */
export function readAllStdin(stream = process.stdin) {
  return new Promise((resolve) => {
    const chunks = [];
    const done = (error) => resolve({ text: Buffer.concat(chunks).toString("utf8"), error });
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => done(null));
    stream.on("error", (err) => done(err));
  });
}

function runChild({ command, args, env, stdinText, passthroughStdin, leader }) {
  return new Promise((resolve) => {
    // Paperclip signals the whole process group, which already reaches the
    // child, so a group leader never forwards (forwarding would deliver every
    // signal twice). Outside a group of our own (e.g. started from a shell) we
    // forward. Decided, and handlers installed, before the child exists.
    let child = null;
    const handlers = ["SIGTERM", "SIGINT", "SIGHUP"].map((sig) => [sig, () => !leader && child?.kill(sig)]);
    // Always handle these, so the wrapper outlives the child and reports its exit.
    for (const [sig, h] of handlers) process.on(sig, h);
    child = spawn(command, args, {
      stdio: [passthroughStdin ? "inherit" : "pipe", "inherit", "inherit"],
      env,
    });
    child.on("error", (err) => {
      process.stderr.write(`${LOG_PREFIX} failed to start ${command}: ${err.message}\n`);
      resolve({ code: 127, signal: null });
    });
    child.on("exit", (code, signal) => {
      for (const [sig, h] of handlers) process.off(sig, h);
      resolve({ code, signal });
    });
    if (!passthroughStdin) {
      child.stdin.on("error", () => {}); // child may exit before reading everything
      child.stdin.end(stdinText);
    }
  });
}

export async function main(cli, argv = process.argv.slice(2)) {
  const startedAt = Date.now();
  const leaderProbe = probeProcessGroupLeader();
  const env = process.env;
  const wrapperPath = process.argv[1];
  const depth = nestingDepth(env[DEPTH_ENV]);
  if (depth >= MAX_DEPTH) {
    process.stderr.write(`${LOG_PREFIX} wrapper called itself ${depth} times; check MEMOS_REAL_COMMAND and PATH\n`);
    return process.exit(127);
  }
  let command;
  try {
    command = resolveRealCommand({ cli, env, wrapperPath });
    if (safeRealpath(command) === safeRealpath(wrapperPath)) {
      throw new Error(`the real ${cli} command resolves to this wrapper; set MEMOS_REAL_COMMAND to the real CLI`);
    }
  } catch (err) {
    process.stderr.write(`${LOG_PREFIX} ${err.message}\n`);
    return process.exit(127);
  }
  const spawnEnv = childEnv(env, depth);
  const diagnostics = [];
  const note = (msg) => diagnostics.push(`${LOG_PREFIX} ${msg}\n`);
  const leaderFor = async () => {
    const leader = await leaderProbe;
    if (leader === null) note("warning: cannot tell the process group (no /bin/ps?); forwarding signals");
    return leader ?? false;
  };
  const flush = () => diagnostics.length && process.stderr.write(diagnostics.join(""));

  // Probes, nested calls and interactive use pass straight through.
  if (!isAgentRun(cli, argv) || depth > 0 || process.stdin.isTTY) {
    const { code, signal } = await runChild({ command, args: argv, env: spawnEnv, passthroughStdin: true, leader: await leaderFor() });
    flush();
    return finish(code, signal);
  }

  const { text: stdinText, error: stdinError } = await readAllStdin();
  let prompt = stdinText;
  if (stdinError) {
    // Do not add memories to a prompt that may be cut short; pass on what arrived.
    note(`warning: reading stdin failed, started ${cli} without memories (${stdinError.message})`);
  } else {
    try {
      const logger = { warn: (msg) => note(`warning: ${msg}`) };
      const recall = await recallForRun({ env, logger, startedAt });
      const injected = injectMemoryBlock({ stdinText, block: recall.block });
      prompt = injected.stdinText;
      note(`recall ${recall.reason}; placement=${injected.placement}; ${Date.now() - startedAt}ms; started ${cli}`);
    } catch (err) {
      // Fail open: run the CLI exactly as the adapter asked.
      note(`warning: recall failed, started ${cli} without memories (${err.message})`);
    }
  }

  const { code, signal } = await runChild({ command, args: argv, env: spawnEnv, stdinText: prompt, passthroughStdin: false, leader: await leaderFor() });
  flush();
  return finish(code, signal);
}

/** Mirror the child's exit. Signals Node ignores or handles (SIGPIPE, SIGUSR1) fall back to 128+n. */
export function finish(code, signal) {
  if (signal) {
    const fallback = 128 + (osConstants.signals[signal] ?? 0);
    if (["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL", "SIGQUIT", "SIGABRT"].includes(signal)) {
      process.kill(process.pid, signal);
    }
    setTimeout(() => process.exit(fallback), 50);
    return;
  }
  process.exit(code ?? 1);
}

/** Entry point used by bin/<cli>/<cli>. */
export function wrapperEntry(cli) {
  main(cli).catch((err) => {
    process.stderr.write(`${LOG_PREFIX} fatal: ${err.stack ?? err}\n`);
    process.exit(1);
  });
}
