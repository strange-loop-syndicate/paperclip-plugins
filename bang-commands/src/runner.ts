import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import type { BangCommand } from "./commands.js";

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  /** Set when the command could not start at all. */
  error?: string;
}

/** Keep at most this many bytes of combined output in memory. */
const MAX_CAPTURE = 1_000_000;

export function runCommand(cmd: BangCommand): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const [file, ...args] = cmd.argv;
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (r: Omit<RunResult, "durationMs" | "output" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, timedOut, durationMs: Date.now() - started, output });
    };

    const child = spawn(file, args, {
      cwd: cmd.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so a timeout kills the whole tree.
      detached: true,
    });
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_CAPTURE) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, cmd.timeoutMs);

    child.on("error", (err) => finish({ exitCode: null, signal: null, error: err.message }));
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));
  });
}

/**
 * Start a command fully detached: own process group, output to a log file,
 * not waited for. It survives the Paperclip server (and this worker) stopping.
 */
export function startDetached(cmd: BangCommand, logPath: string): { pid: number | undefined } {
  const fd = openSync(logPath, "a");
  const [file, ...args] = cmd.argv;
  const child = spawn(file, args, {
    cwd: cmd.cwd,
    shell: false,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  return { pid: child.pid };
}
