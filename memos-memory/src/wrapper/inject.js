// Put the memory block in front of the stdin prompt, for both CLIs.
//
// Both adapters send the prompt on stdin (claude `--print`, codex `exec … -`),
// so one placement covers fresh and resumed sessions alike. Memories are
// agent-written text, so they go in the user turn, never the system prompt:
// a stored prompt injection gets no more authority than the prompt itself,
// and Claude and Codex treat memories the same way.

/** True when this invocation is an agent run (not a --version/--help probe). */
export function isAgentRun(cli, args) {
  if (cli === "claude") return args.includes("--print") || args.includes("-p");
  if (cli === "codex") return args.includes("exec");
  return false;
}

/** Returns { stdinText, placement }. */
export function injectMemoryBlock({ stdinText, block }) {
  if (!block) return { stdinText, placement: "none" };
  return { stdinText: `${block}\n\n${stdinText}`, placement: "stdin" };
}
