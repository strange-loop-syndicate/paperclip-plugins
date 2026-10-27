// A code check after the extractor: drops memories that are task logs or
// task status, whatever the model wrote. A memory must still be true and
// useful after its source task closes. The extractor prompt asks for the same;
// this check holds when the model does not follow it (SLS-200).

const RULES = [
  ["run-or-card-id", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  // Git commit hashes: lower-case hex with at least one digit and one letter.
  ["commit-hash", /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/],
  ["pr-number", /\b(?:PR|pull request)\s*#?\d+/i],
  // Test and check counts: "26/26", "39 tests pass", "7 mutations caught", "exited 0".
  ["test-count", /\b\d+\s*\/\s*\d+\s*(?:tests?|checks?|mutations?|files?|pass|passed|passing|applied|caught|fail(?:ed)?)?\b(?!\s*(?:s|ms|min|h|%))/i],
  ["test-count", /\b\d+\s+(?:tests?|mutations?|checks?)\s+(?:pass|passed|passing|caught|fail|failed|green)\b/i],
  ["exit-code", /\b(?:exited|exit code|rc)\s*[:=]?\s*\d+\b/i],
  // Task state that goes stale: blocked, waiting, pending, still, not yet.
  [
    "task-status",
    /\b(?:still|not yet|so far|right now|currently|for now|meanwhile|stays? (?:blocked|open|pending|off)|(?:is|are) (?:now )?(?:blocked|pending|todo|in_review|in_progress)|remains? (?:blocked|open|pending)|pending (?:on|with|until)|waits? (?:on|for)|waiting (?:on|for)|awaits?|is now (?:in|on|at)|no change since|has not (?:yet )?been)\b/i,
  ],
  // Per-task outcomes: something was merged, deployed, accepted or closed.
  [
    "task-outcome",
    /\b(?:was|were|is|has been|have been|got)\s+(?:merged|deployed|accepted|approved|closed|reviewed|released|shipped|reverted|cancelled|canceled|posted|filed|opened)\b|\b(?:passed|failed) (?:review|code review)\b|\bmerged (?:as|to main|into main)\b/i,
  ],
];

/**
 * Why `text` is not a durable memory, or null when it may be one.
 * `taskPrefix` (for example "SLS") also drops a memory that names a task of
 * this company: a durable memory makes sense without the task ID.
 */
export function noiseReason(text, { taskPrefix = null } = {}) {
  const s = String(text ?? "");
  for (const [reason, re] of RULES) if (re.test(s)) return reason;
  if (taskPrefix && /^[A-Z][A-Z0-9]{0,9}$/.test(taskPrefix) && new RegExp(`\\b${taskPrefix}-\\d+\\b`).test(s)) return "task-id";
  return null;
}

/** The issue prefix of a task identifier: "SLS-200" -> "SLS". */
export function taskPrefixOf(identifier) {
  return /^([A-Z][A-Z0-9]{0,9})-\d+$/.exec(String(identifier ?? ""))?.[1] ?? null;
}
