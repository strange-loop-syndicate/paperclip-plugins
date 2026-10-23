/**
 * Config. `!<text>` from an allowed user runs `<text>` in a shell, except that
 * a bare `!<name>` matching a shortcut below runs that shortcut instead.
 * Edit this file, then run `npm run build`.
 */

/** Only comments by these Paperclip user ids trigger anything. */
export const ALLOWED_USER_IDS = ["local-board"];

/** Shell for free-text commands. Login shell, so PATH matches a terminal. */
export const SHELL = ["/bin/zsh", "-lc"];
export const SHELL_CWD = "/Users/claude/work/workspace";
export const SHELL_TIMEOUT_MS = 120_000;

export interface BangCommand {
  /** Shortcut name; for free-text shell commands, the command text. */
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

/** A free-text shell command from a comment. */
export function shellCommand(script: string): BangCommand {
  return {
    name: script,
    description: "shell",
    argv: [...SHELL, script],
    cwd: SHELL_CWD,
    timeoutMs: SHELL_TIMEOUT_MS,
  };
}
