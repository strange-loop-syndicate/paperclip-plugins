#!/usr/bin/env node
// Stand-in for the claude / codex CLI. Records when it started, its args, the
// contents of any --append-system-prompt-file, and its stdin, to $FAKE_CLI_OUT.

import { readFileSync, writeFileSync } from "node:fs";

const startedAt = Date.now();
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("9.9.9 (fake)\n");
  process.exit(0);
}

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const fileIdx = args.indexOf("--append-system-prompt-file");
  let systemPromptFile = null;
  if (fileIdx !== -1) {
    try {
      systemPromptFile = readFileSync(args[fileIdx + 1], "utf8");
    } catch (err) {
      systemPromptFile = `<<unreadable: ${err.message}>>`;
    }
  }
  writeFileSync(
    process.env.FAKE_CLI_OUT,
    JSON.stringify({
      startedAt,
      args,
      systemPromptFile,
      stdin: Buffer.concat(chunks).toString("utf8"),
      memosEnvKeys: Object.keys(process.env).filter((k) => k.startsWith("MEMOS_")),
      wrappedDepth: process.env.PAPERCLIP_MEMOS_WRAPPED ?? null,
    }),
  );
  if (process.env.FAKE_CLI_STDERR) process.stderr.write(`${process.env.FAKE_CLI_STDERR}\n`);
  process.stdout.write(`${JSON.stringify({ type: "result", result: "ok" })}\n`);
  process.exit(Number(process.env.FAKE_CLI_EXIT ?? 0));
});
