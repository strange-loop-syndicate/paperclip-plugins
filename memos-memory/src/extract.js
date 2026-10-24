// Deterministic extraction of durable memories from agent-written text.
// v1 is marker-based: an agent line counts as a memory only when it is
// labelled, e.g. "**Decision:** …", "Lesson: …", "Root cause: …".

// A marker needs a separator: "Decision: x" or "Decision - x", never
// "Decision pending …" or "Decision-making …".
const SEP = String.raw`(?:\s*:|\s+[-–—])\s*`;
const marker = (words) => new RegExp(`^(?:${words})${SEP}`, "i");
const MARKERS = [
  { kind: "decision", re: marker("decision|decided|we decided|i decided|chose|choice") },
  { kind: "lesson", re: marker("lessons?(?: learned)?|learned|gotcha|root cause|pitfall|note to self|engineering lesson") },
  { kind: "outcome", re: marker("outcome|result|resolution") },
];

const MIN_CHARS = 15;
const MAX_CHARS = 800;

function stripLinePrefix(line) {
  return line
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/, "") // list bullet
    .replace(/^\s*#{1,6}\s+/, "") // heading
    .replace(/^(\*\*|__)(.+?)\1/, "$2") // bold label, e.g. **Decision:**
    .trim();
}

/** Returns [{ kind, content }] for every labelled line in `text`. */
export function extractMemories(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const out = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    // Quoted text is someone else's words, not this agent's decision.
    if (inFence || /^\s*>/.test(raw)) continue;
    const line = stripLinePrefix(raw);
    for (const { kind, re } of MARKERS) {
      if (!re.test(line)) continue;
      const content = line.replace(re, "").trim();
      if (content.length >= MIN_CHARS) out.push({ kind, content: content.slice(0, MAX_CHARS) });
      break;
    }
  }
  return out;
}

/** One task-outcome memory for a finished run. */
export function buildRunOutcome({ issue, summary }) {
  const ref = issue.identifier ? `${issue.identifier} ` : "";
  const title = issue.title ? `"${issue.title}"` : "(untitled issue)";
  const status = issue.status ? ` Issue status after the run: ${issue.status}.` : "";
  const firstPara = typeof summary === "string" ? summary.trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ").slice(0, 500) : "";
  return `Run finished on ${ref}${title}.${status}${firstPara ? ` Summary: ${firstPara}` : ""}`;
}
