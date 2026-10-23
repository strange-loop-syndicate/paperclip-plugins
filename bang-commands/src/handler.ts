import type { BangCommand } from "./commands.js";
import type { RunResult } from "./runner.js";

/** Max characters of command output in a reply comment. */
export const MAX_OUTPUT_CHARS = 6_000;

export type Parsed =
  | { kind: "none" }
  | { kind: "run"; command: BangCommand }
  | { kind: "unknown"; name: string }
  | { kind: "has-args"; command: BangCommand };

const SINGLE = /^!([A-Za-z0-9][A-Za-z0-9_-]*)$/;
const LEADING = /^!([A-Za-z0-9][A-Za-z0-9_-]*)[^A-Za-z0-9_-]/;

/**
 * A comment triggers only when its whole trimmed body is `!<name>`.
 * `!<known-name> <more text>` gets a "no arguments" reply. Anything else
 * (prose that happens to start with `!`) is ignored.
 */
export function parseComment(body: string, commands: BangCommand[]): Parsed {
  const text = body.trim();
  const single = SINGLE.exec(text);
  if (single) {
    const command = commands.find((c) => c.name === single[1].toLowerCase());
    return command ? { kind: "run", command } : { kind: "unknown", name: single[1] };
  }
  const leading = LEADING.exec(text);
  if (leading) {
    const command = commands.find((c) => c.name === leading[1].toLowerCase());
    if (command) return { kind: "has-args", command };
  }
  return { kind: "none" };
}

export function truncate(output: string, max = MAX_OUTPUT_CHARS): string {
  if (output.length <= max) return output;
  const cut = output.length - max;
  return `[… ${cut} earlier characters cut …]\n${output.slice(-max)}`;
}

/** Code fence longer than any backtick run inside the text. */
export function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}text\n${text}\n${f}`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatResult(cmd: BangCommand, r: RunResult): string {
  let status: string;
  if (r.error) status = `failed to start: ${r.error}`;
  else if (r.timedOut) status = `timed out after ${formatDuration(cmd.timeoutMs)} (killed)`;
  else if (r.exitCode === null) status = `killed by ${r.signal ?? "signal"}`;
  else status = `exit ${r.exitCode}`;
  const icon = !r.error && !r.timedOut && r.exitCode === 0 ? "✅" : "❌";
  const body = r.output.trim() ? fence(truncate(r.output.trimEnd())) : "_(no output)_";
  return `${icon} **\`!${cmd.name}\`** · ${status} · ${formatDuration(r.durationMs)}\n\n${body}`;
}

export function formatList(commands: BangCommand[]): string {
  return commands.map((c) => `- \`!${c.name}\` — ${c.description}`).join("\n");
}

export function formatUnknown(name: string, commands: BangCommand[]): string {
  return `❓ Unknown command \`!${name}\`. Allowed commands:\n\n${formatList(commands)}`;
}

export function formatHasArgs(cmd: BangCommand, commands: BangCommand[]): string {
  return `❌ \`!${cmd.name}\` takes no arguments. Write the command alone in the comment. Allowed commands:\n\n${formatList(commands)}`;
}
