// Argument parsing and output for the `linear` CLI. All I/O is injected so tests need no network or disk.

import { readFile as fsReadFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import {
  LinearError,
  ReadbackError,
  UsageError,
  comment,
  createClient,
  getIssue,
  listComments,
  resolveComment,
  setState,
  whoami,
} from "./linear.mjs";

const MAX_BODY_BYTES = 256 * 1024;

export const USAGE = `Usage: linear <command> [args]

Commands (JSON on stdout):
  whoami                                         Who the key acts as
  get-issue <KEY>                                One issue (KEY like M-123)
  list-comments <KEY>                            All comments, every page, with parentId and resolvedAt
  set-state <KEY> <state name>                   Move to the team's state with that name, then read back
  comment <KEY> --body-file F [--parent <id>]    Post a comment or threaded reply, then read back
  resolve-comment <commentId>                    Resolve a comment thread, then read back

Key: env LINEAR_API_KEY only. No .env files are read.
Exit codes: 0 ok, 1 Linear or network error, 2 usage error, 3 write done but readback does not match.`;

const COMMANDS = {
  whoami: { positionals: 0 },
  "get-issue": { positionals: 1 },
  "list-comments": { positionals: 1 },
  "set-state": { positionals: 2, rest: true },
  comment: { positionals: 1, options: { "body-file": { type: "string" }, parent: { type: "string" } } },
  "resolve-comment": { positionals: 1 },
};

/** Files a comment body must never come from: secrets would land in Linear. */
function isSecretFile(path) {
  const name = basename(path).toLowerCase();
  return name.startsWith(".env") || name.endsWith(".pem") || name.endsWith(".key");
}

async function readBody(path, readFile) {
  if (isSecretFile(path)) throw new UsageError(`refusing to read ${basename(path)} as a comment body`);
  let buf;
  try {
    buf = await readFile(path);
  } catch (err) {
    throw new UsageError(`cannot read --body-file ${path}: ${err instanceof Error ? err.message : err}`);
  }
  if (buf.length > MAX_BODY_BYTES) throw new UsageError(`--body-file is over ${MAX_BODY_BYTES} bytes`);
  return buf.toString("utf8");
}

/**
 * Runs one command. Returns the exit code; never calls process.exit.
 * Output: the result as pretty JSON on stdout; errors as `linear: <message>` on stderr.
 */
export async function run({ argv, env, fetchImpl = globalThis.fetch, readFile = fsReadFile, stdout, stderr }) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    (command ? stdout : stderr)(USAGE + "\n");
    return command ? 0 : 2;
  }
  const spec = COMMANDS[command];
  if (!spec) {
    stderr(`linear: unknown command "${command}"\n\n${USAGE}\n`);
    return 2;
  }

  try {
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: spec.options ?? {}, allowPositionals: true, strict: true });
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    let positionals = parsed.positionals;
    // `set-state M-1 In Review` and `set-state M-1 "In Review"` both work.
    if (spec.rest && positionals.length > spec.positionals) {
      positionals = [...positionals.slice(0, spec.positionals - 1), positionals.slice(spec.positionals - 1).join(" ")];
    }
    if (positionals.length !== spec.positionals) {
      throw new UsageError(`${command} takes ${spec.positionals} argument(s), got ${positionals.length}`);
    }

    const apiKey = typeof env.LINEAR_API_KEY === "string" ? env.LINEAR_API_KEY.trim() : "";
    if (!apiKey) {
      throw new UsageError("LINEAR_API_KEY is not set. Bind it in the agent's environment; this CLI reads no .env files.");
    }
    const client = createClient({ apiKey, fetchImpl });

    let result;
    switch (command) {
      case "whoami":
        result = await whoami(client);
        break;
      case "get-issue":
        result = await getIssue(client, positionals[0]);
        break;
      case "list-comments":
        result = await listComments(client, positionals[0]);
        break;
      case "set-state":
        result = await setState(client, positionals[0], positionals[1]);
        break;
      case "comment": {
        const bodyFile = parsed.values["body-file"];
        if (!bodyFile) throw new UsageError("comment needs --body-file F");
        const body = await readBody(bodyFile, readFile);
        result = await comment(client, positionals[0], { body, parentId: parsed.values.parent });
        break;
      }
      case "resolve-comment":
        result = await resolveComment(client, positionals[0]);
        break;
    }
    stdout(JSON.stringify(result, null, 2) + "\n");
    return 0;
  } catch (err) {
    if (err instanceof ReadbackError) {
      stdout(JSON.stringify(err.readback, null, 2) + "\n");
      stderr(`linear: readback mismatch: ${err.message}\n`);
      return 3;
    }
    if (err instanceof UsageError) {
      stderr(`linear: ${err.message}\n`);
      return 2;
    }
    if (err instanceof LinearError) {
      stderr(`linear: ${err.message}\n`);
      return 1;
    }
    stderr(`linear: unexpected error: ${err instanceof Error ? err.message : err}\n`);
    return 1;
  }
}
