// A capture item: one comment (agent or board) or one run result. Only IDs
// are kept between steps; the text is re-read from the host when needed and
// never stored.

export const MAX_ITEM_CHARS = 12000;
const CODE_PLACEHOLDER = "[code block removed]";

/**
 * The text Jev and the extractor see: fenced code blocks and `<details>`
 * evidence sections are cut, whitespace runs are squeezed, length is capped.
 */
export function itemText(body) {
  if (typeof body !== "string") return "";
  const out = [];
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      out.push(CODE_PLACEHOLDER);
      continue;
    }
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/<details>[\s\S]*?<\/details>/gi, CODE_PLACEHOLDER)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_ITEM_CHARS);
}

/** True when the text has words left after code is cut. */
export function hasProse(text) {
  return text.replaceAll(CODE_PLACEHOLDER, "").replace(/\W+/g, "").length >= 20;
}

export function commentItemKey(commentId) {
  return `comment:${commentId}`;
}

/** Source label for Jev and the extractor. */
export function sourceLabel(authorType, viaRun) {
  if (viaRun) return "run result";
  return authorType === "user" ? "board comment" : "agent comment";
}
