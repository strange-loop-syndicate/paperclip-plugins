import { createHash } from "node:crypto";

/**
 * Remove Markdown emphasis that comes in pairs around text (`**x**`, `*x*`,
 * `~~x~~`, `` `x` ``, and `_x_` / `__x__` at word edges). Lone `_` and `~`
 * stay, so `MAX_RETRIES` and `~/.config` keep their meaning.
 */
export function stripEmphasis(text) {
  return String(text ?? "")
    .replace(/(\*\*|\*|~~|`+)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w])(__|_)(?=\S)([\s\S]*?\S)\2(?!\w)/g, "$1$3");
}

/**
 * Normalize memory text so trivially different copies of the same lesson
 * (case, whitespace, markdown emphasis, trailing punctuation) hash the same.
 */
export function normalizeContent(text) {
  return stripEmphasis(String(text ?? "").normalize("NFKC"))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:!]+$/, "")
    .toLowerCase();
}

/** sha256 of the normalized content, hex. */
export function contentHash(text) {
  return createHash("sha256").update(normalizeContent(text)).digest("hex");
}
