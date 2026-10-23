#!/usr/bin/env node
// Patch the installed Paperclip server so an owner `!command` comment does not
// wake the task's agent. The Bang Commands plugin wakes the agent itself after
// it posts the command output, so the agent starts with the output in hand.
//
// Usage: node scripts/patch-paperclip-server.mjs [--check | --revert] [server-dist-dir]
// Paperclip updates overwrite node_modules, so re-run this after every update.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = "/* bang-commands-patch v1 */";
const args = process.argv.slice(2);
const mode = args.includes("--check") ? "check" : args.includes("--revert") ? "revert" : "apply";
const dist =
  args.find((a) => !a.startsWith("--")) ??
  "/Users/claude/work/paperclip/app/node_modules/@paperclipai/server/dist";
const file = join(dist, "routes/issues.js");
const backup = `${file}.bang-orig`;

const HELPER = `
${MARKER}
function isBangCommandComment(actor, comment) {
    return actor?.actorType === "user" && typeof comment?.body === "string" && /^\\s*!\\s*\\S/.test(comment.body);
}
`;
// Both comment wake guards: PATCH /issues/:id (comment + update) and POST /issues/:id/comments.
const EDITS = [
  ["                    !goalCommentSteered &&\n                    shouldWakeAssigneeForComment) {",
   "                    !goalCommentSteered &&\n                    shouldWakeAssigneeForComment &&\n                    !isBangCommandComment(actor, comment)) {"],
  ["            if (assigneeId && !goalCommentSteered && shouldWakeAssigneeForComment) {",
   "            if (assigneeId && !goalCommentSteered && shouldWakeAssigneeForComment && !isBangCommandComment(actor, comment)) {"],
];
const ANCHOR = 'import { privateJsonEtag } from "../middleware/private-json-etag.js";\n';

const src = readFileSync(file, "utf8");
const patched = src.includes(MARKER);

if (mode === "check") {
  console.log(patched ? "patched" : "not patched");
  process.exit(patched ? 0 : 1);
}
if (mode === "revert") {
  if (!patched) {
    console.log("not patched, nothing to revert");
    process.exit(0);
  }
  if (!existsSync(backup)) throw new Error(`backup missing: ${backup}`);
  copyFileSync(backup, file);
  console.log("reverted; restart Paperclip");
  process.exit(0);
}
if (patched) {
  console.log("already patched");
  process.exit(0);
}
let out = src;
for (const [from, to] of [[ANCHOR, ANCHOR + HELPER], ...EDITS]) {
  const n = out.split(from).length - 1;
  if (n !== 1) throw new Error(`expected 1 match, found ${n}: ${from.trim().slice(0, 60)}… (Paperclip changed; update this script)`);
  out = out.replace(from, to);
}
copyFileSync(file, backup);
writeFileSync(file, out);
console.log("patched; restart Paperclip");
