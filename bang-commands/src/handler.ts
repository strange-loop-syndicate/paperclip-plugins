import { shellCommand, type BangCommand } from "./commands.js";
import { codeWrapperContent, markdownToCommand } from "./markdown.js";
import type { RunResult } from "./runner.js";

/** Max characters of command output in a reply comment. */
export const MAX_OUTPUT_CHARS = 6_000;

export type Parsed =
  | { kind: "none" }
  | { kind: "image" }
  | { kind: "help" }
  | { kind: "run"; command: BangCommand };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * A comment triggers when its trimmed body starts with `!`.
 * - `![…` (a markdown image, such as a pasted screenshot) → image: runs nothing.
 * - one code block or code span after `!` → its content runs in a shell, byte-for-byte.
 * - otherwise the stored Markdown is turned back into the typed text, then:
 *   `!help` → list of shortcuts; `!<name>` matching a shortcut → that shortcut;
 *   anything else → runs in a shell (may be multi-line).
 */
export function parseComment(body: string, commands: BangCommand[]): Parsed {
  const text = body.trim();
  if (!text.startsWith("!")) return { kind: "none" };
  const stored = text.slice(1).trim();
  if (!stored) return { kind: "none" };
  if (stored.startsWith("[")) return { kind: "image" };
  const code = codeWrapperContent(stored);
  if (code !== null) return code.trim() ? { kind: "run", command: shellCommand(code) } : { kind: "none" };
  const rest = markdownToCommand(stored);
  if (!rest) return { kind: "none" };
  if (rest.toLowerCase() === "help") return { kind: "help" };
  if (NAME.test(rest)) {
    const command = commands.find((c) => c.name === rest.toLowerCase());
    if (command) return { kind: "run", command };
  }
  return { kind: "run", command: shellCommand(rest) };
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
  return `${icon} **${label(cmd)}** · ${status} · ${formatDuration(r.durationMs)}\n\n${body}`;
}

/** Inline code span that survives backticks in the text. */
export function inlineCode(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return longest ? `${f} ${text} ${f}` : `${f}${text}${f}`;
}

/** `!name`, or the first line of a shell command, cut to 80 characters. */
export function label(cmd: BangCommand): string {
  const lines = cmd.name.split("\n");
  let text = lines[0];
  if (text.length > 80) text = `${text.slice(0, 80)}…`;
  else if (lines.length > 1) text += " …";
  return inlineCode(`!${text}`);
}

export function formatList(commands: BangCommand[]): string {
  return commands.map((c) => `- \`!${c.name}\` — ${c.description}`).join("\n");
}

export function formatHelp(commands: BangCommand[]): string {
  return `Shortcuts:\n\n${formatList(commands)}\n\nAny other \`!<command>\` runs in a shell.`;
}
