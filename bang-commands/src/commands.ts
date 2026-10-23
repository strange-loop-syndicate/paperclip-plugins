/**
 * The allowlist. `!<name>` in a task comment runs exactly one entry below.
 * Comment text is never passed to the command: no arguments, no shell.
 * Edit this file to add or remove commands, then run `npm run build`.
 */

export interface BangCommand {
  name: string;
  description: string;
  /** argv; argv[0] is the executable. Runs without a shell. */
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  /**
   * Start the command in its own process group, do not wait for it, and reply
   * at once. For commands that stop Paperclip itself (and so this plugin).
   */
  detached?: boolean;
}

const PAPERCLIP_ROOT = "/Users/claude/work/paperclip";
const LAB_REPO = "/Users/claude/work/workspace/lab";

/** Plugin root: `dist/worker.js` sits one folder below it. */
export function pluginRoot(workerUrl: string): string {
  return new URL("..", workerUrl).pathname.replace(/\/$/, "");
}

export function buildCommands(root: string): BangCommand[] {
  return [
    {
      name: "status",
      description: "Paperclip health endpoint (read-only)",
      argv: ["/usr/bin/curl", "-sS", "-m", "10", "http://127.0.0.1:3100/api/health"],
      timeoutMs: 15_000,
    },
    {
      name: "git-status-lab",
      description: "`git status` in the lab repo (read-only)",
      argv: ["/usr/bin/git", "-C", LAB_REPO, "status", "--short", "--branch"],
      timeoutMs: 15_000,
    },
    {
      name: "git-pull-lab",
      description: "`git pull --ff-only` in the lab repo",
      argv: ["/usr/bin/git", "-C", LAB_REPO, "pull", "--ff-only"],
      timeoutMs: 60_000,
    },
    {
      name: "check-updates",
      description: "Installed vs latest `paperclipai` version on npm (read-only, installs nothing)",
      argv: ["/bin/sh", `${root}/scripts/check-updates.sh`],
      cwd: PAPERCLIP_ROOT,
      timeoutMs: 60_000,
    },
    {
      name: "restart-paperclip",
      description: "Restart the Paperclip server after a 5 s delay (stops all running agent runs)",
      argv: ["/bin/sh", `${root}/scripts/restart-paperclip.sh`],
      cwd: PAPERCLIP_ROOT,
      timeoutMs: 120_000,
      detached: true,
    },
  ];
}
