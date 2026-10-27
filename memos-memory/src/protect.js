// Paths, URLs and addresses go to the extractor as placeholders and come back
// as written. The OpenRouter extract call rewrote `/Users/claude/...` to
// `/Users/[PERSON_NAME]/...` (37 stored memories, SLS-199): the user name in a
// path read as a person. MemOS itself stores text as given (checked in
// SLS-200), so the fix sits around the extract call.

const SPAN_PATTERNS = [
  // URLs
  /\bhttps?:\/\/[^\s<>"'`)\]]+/g,
  // Email addresses
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  // IPv4, with an optional port
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g,
  // Absolute, home and relative paths: /a/b, ~/a, ./a, ../a
  /(?<![\w/.~-])(?:~|\.{1,2})?\/[\w.@%+~-]+(?:\/[\w.@%+~-]*)*/g,
  // Relative paths with at least three parts: current/bin/claude/claude
  /(?<![\w/.~{-])[\w.@%+~-]+(?:\/[\w.@%+~-]+){2,}\/?/g,
];
const TRAILING = /[.,;:!?]+$/;
const TOKEN = /\{\{P(\d+)\}\}/g;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every path, URL, email and IPv4 address in `text`, and every word in
 * `terms` (exact, whole word), with `{{P1}}`, `{{P2}}`, ... The same span gets
 * the same token. Returns `{ text, spans }`; pass `spans` to `restoreSpans`.
 */
export function protectSpans(text, { terms = [], spans = [] } = {}) {
  let out = String(text ?? "");
  const tokenFor = (span) => {
    let i = spans.indexOf(span);
    if (i === -1) i = spans.push(span) - 1;
    return `{{P${i + 1}}}`;
  };
  // Existing placeholders in the source would restore to the wrong span.
  out = out.replace(TOKEN, (m) => tokenFor(m));
  for (const re of SPAN_PATTERNS) {
    out = out.replace(re, (m) => {
      if (m.startsWith("{{P")) return m;
      const trail = TRAILING.exec(m)?.[0] ?? "";
      const span = trail ? m.slice(0, -trail.length) : m;
      if (span.length < 3 || span === "/" || !/[\w]/.test(span)) return m;
      return `${tokenFor(span)}${trail}`;
    });
  }
  for (const term of terms) {
    if (typeof term !== "string" || term.trim().length < 2) continue;
    out = out.replace(new RegExp(`(?<![\\w{])${escapeRegExp(term.trim())}(?![\\w}])`, "g"), (m) => tokenFor(m));
  }
  return { text: out, spans };
}

/** Put the protected spans back. Unknown tokens stay as they are. */
export function restoreSpans(text, spans) {
  return String(text ?? "").replace(TOKEN, (m, n) => spans[Number(n) - 1] ?? m);
}

/** A placeholder left in a memory: one `restoreSpans` did not know. */
export const PLACEHOLDER = /\{\{P\d+\}\}/;

/** A redaction label some provider wrote in place of a name or address. */
export const REDACTION_LABEL = /\[(?:PERSON_NAME|PERSON|NAME|IP_ADDRESS|ADDRESS|EMAIL(?:_ADDRESS)?|PHONE(?:_NUMBER)?|LOCATION|URL)\]/;
