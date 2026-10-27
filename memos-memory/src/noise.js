// A code check after the extractor: drops memories that are task logs, task
// status or company process rules, whatever the model wrote. A memory must still be true and
// useful after its source task closes. The extractor prompt asks for the same;
// this check holds when the model does not follow it (SLS-200).

const RULES = [
  ["run-or-card-id", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  // Git commit hashes: lower-case hex with at least one digit and one letter.
  ["commit-hash", /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/],
  ["pr-number", /\b(?:PR|pull request)\s*#?\d+/i],
  // Test and check counts: "26/26", "39 tests pass", "7 mutations caught", "exited 0".
  // Not a CIDR range (100.64.0.0/10) or a date (2026/10/27).
  ["test-count", /(?<![\d./])\d+\s*\/\s*\d+(?!\d|\/|\.\d)(?!\s*(?:s|ms|min|h|%)\b)/],
  ["test-count", /\b\d+\s+(?:tests?|mutations?|checks?)\s+(?:pass|passed|passing|caught|fail|failed|green)\b/i],
  ["exit-code", /\b(?:exited|exit code|rc)\s*[:=]?\s*\d+\b/i],
  // Task state that goes stale: blocked, waiting, pending. "still", "currently"
  // and "not yet" count only with a status word: "X still passes" is a lesson.
  [
    "task-status",
    /\b(?:(?:still|currently) (?:blocked|pending|open|waiting|running|in review|in_review|in progress|in_progress|todo|on hold|unmerged|unanswered|undecided|not (?:merged|deployed|done|fixed|decided|answered|approved|reviewed|started))|not yet (?:merged|deployed|done|fixed|decided|answered|approved|reviewed|started|run)|stays (?:blocked|open|pending|off)|(?:is|are) (?:now )?(?:blocked|pending|todo|in_review|in_progress)|remains (?:blocked|open|pending)|pending (?:on|with|until)|waits? (?:on|for)|waiting (?:on|for)|awaits?|is now (?:in|on|at)|no change since|has not (?:yet )?been)\b/i,
  ],
  // Per-task outcomes: something was merged, deployed, accepted or closed.
  // Past and perfect tense only: "a PR is merged only by …" is a rule.
  [
    "task-outcome",
    /\b(?:was|were|has been|have been|got)\s+(?:merged|deployed|accepted|approved|closed|reviewed|released|shipped|reverted|cancelled|canceled|posted|filed|opened)\b|\b(?:passed|failed) (?:review|code review)\b|\bmerged (?:as|to main|into main)\b/i,
  ],
];

// Company process rules: chain of command, cards, review and approval routes,
// task closure, who merges. Agents get these from AGENTS.md, and a memory copy
// goes stale when the rule changes (SLS-199). Two shapes only, so that lessons
// about how Paperclip behaves stay:
// - a company role next to a process word ("the Project Director merges");
// - a card next to a task status, unless the memory is about Paperclip itself.
// Role names are matched by case, and removed before the process words are,
// so "Code Reviewer" alone is not "review".
const ROLE = /\b(?:(?:Project )?Directors?|Project Leads?|Code Reviewers?|Architects?|Engineers?|DevOps|Experiment Owners?|task creators?|approvers?)\b/g;
const PROCESS_WORD = /\b(?:merges?|merged|merging|reviews?|reviewed|reviewing|approv\w*|accept\w*|sign[- ]?offs?|cards?|escalat\w*|clos(?:e|es|ed|ing)|chain of command)\b/i;
const CARD = /\bcards?\b/i;
const CARD_STATUS = /\b(?:blocked|in_review|in review)\b/i;

function isProcessRule(s) {
  if (s.match(ROLE) && PROCESS_WORD.test(s.replace(ROLE, " "))) return true;
  return CARD.test(s) && CARD_STATUS.test(s) && !/\bPaperclip\b/i.test(s);
}

/**
 * Why `text` is not a durable memory, or null when it may be one.
 * `taskPrefix` (for example "SLS") also drops a memory that names a task of
 * this company: a durable memory makes sense without the task ID.
 */
export function noiseReason(text, { taskPrefix = null } = {}) {
  const s = String(text ?? "");
  for (const [reason, re] of RULES) if (re.test(s)) return reason;
  if (isProcessRule(s)) return "process-rule";
  if (taskPrefix && /^[A-Z][A-Z0-9]{0,9}$/.test(taskPrefix) && new RegExp(`\\b${taskPrefix}-\\d+\\b`).test(s)) return "task-id";
  return null;
}

/** The issue prefix of a task identifier: "SLS-200" -> "SLS". */
export function taskPrefixOf(identifier) {
  return /^([A-Z][A-Z0-9]{0,9})-\d+$/.exec(String(identifier ?? ""))?.[1] ?? null;
}
