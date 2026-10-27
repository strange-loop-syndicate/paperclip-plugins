/**
 * Turn a comment's stored Markdown back into the text the user typed.
 * The comment editor escapes ASCII punctuation (`_` → `\_`), encodes edge
 * whitespace (`&#x20;`), turns Enter into paragraphs and typed URLs into links.
 * A command that is one fenced code block or one inline code span runs
 * byte-for-byte. See README.md → "Special characters".
 */

/** CommonMark: a backslash before any of these is an escape. */
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const ENTITY = /^&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/;

export function markdownToCommand(markdown: string): string {
  const code = codeWrapperContent(markdown.trim());
  if (code !== null) return code;
  // Text mixed with code blocks: unescape the text, keep block content as is.
  return splitFencedBlocks(markdown.trim())
    .map((b) => (b.code ? b.text : unescapeMarkdown(b.text).replace(/^\n+|\n+$/g, "")))
    .filter((text, i, all) => text || all.length === 1)
    .join("\n")
    .trim();
}

/** Content of a text that is exactly one fenced code block or one inline code span; else null. */
export function codeWrapperContent(text: string): string | null {
  const blocks = splitFencedBlocks(text);
  if (blocks.length === 1 && blocks[0].code) return blocks[0].text;
  return inlineCodeContent(text);
}

/** Split text into Markdown text and fenced code block content, in order. */
function splitFencedBlocks(text: string): { code: boolean; text: string }[] {
  const lines = text.split("\n");
  const blocks: { code: boolean; text: string }[] = [];
  let plain: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    // A backtick fence's info string may not contain a backtick (CommonMark).
    if (!open || (open[1][0] === "`" && open[2].includes("`"))) {
      plain.push(lines[i]);
      continue;
    }
    const marker = open[1];
    const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
    let end = lines.findIndex((line, j) => j > i && close.test(line));
    // Unclosed: CommonMark runs the block to the end of the text.
    if (end === -1) end = lines.length;
    if (plain.length) blocks.push({ code: false, text: plain.join("\n") });
    plain = [];
    blocks.push({ code: true, text: lines.slice(i + 1, end).join("\n") });
    i = end;
  }
  if (plain.length || !blocks.length) blocks.push({ code: false, text: plain.join("\n") });
  return blocks;
}

function inlineCodeContent(text: string): string | null {
  const m = /^(`+)(?!`)([\s\S]*[^`])\1$/.exec(text);
  if (!m) return null;
  const ticks = m[1].length;
  // A backtick run of the same length inside would close the span early.
  if ([...m[2].matchAll(/`+/g)].some((r) => r[0].length === ticks)) return null;
  let content = m[2];
  // CommonMark strips one padding space on each side when both are present.
  if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim()) {
    content = content.slice(1, -1);
  }
  return content;
}

/** Undo the editor's escaping, left to right, as a CommonMark reader would. */
export function unescapeMarkdown(md: string): string {
  let out = "";
  let i = 0;
  while (i < md.length) {
    const c = md[i];

    if (c === "\\") {
      const next = md[i + 1];
      if (next === "\n" && !isBlankLineAt(md, i + 2)) {
        // Hard break (Shift+Enter) → newline.
        out += "\n";
        i += 2;
      } else if (next !== undefined && ASCII_PUNCT.test(next)) {
        out += next;
        i += 2;
      } else {
        out += "\\";
        i += 1;
      }
      continue;
    }

    if (c === "`") {
      const span = codeSpanEnd(md, i);
      // Code span from typed backticks: keep it as typed, contents untouched.
      out += md.slice(i, span);
      i = span;
      continue;
    }

    if (c === "&") {
      const m = ENTITY.exec(md.slice(i));
      if (m) {
        out += decodeEntity(m);
        i += m[0].length;
        continue;
      }
    }

    if (c === "[") {
      const link = parseLink(md, i);
      if (link) {
        // An auto-linked URL (or a link) → the text the user typed.
        out += unescapeMarkdown(link.text);
        i = link.end;
        continue;
      }
    }

    if (c === "\n") {
      // Count newlines across whitespace-only lines.
      let j = i;
      let newlines = 0;
      while (j < md.length) {
        const lineEnd = md.indexOf("\n", j);
        if (md[j] === "\n") {
          newlines += 1;
          j += 1;
        } else if (lineEnd !== -1 && md.slice(j, lineEnd).trim() === "") {
          j = lineEnd;
        } else break;
      }
      // Two trailing spaces are a hard break, not part of the text.
      if (newlines === 1) out = out.replace(/ {2,}$/, "");
      // Each paragraph adds one blank line; each empty paragraph two more.
      out += "\n".repeat(newlines === 1 ? 1 : Math.floor(newlines / 2));
      i = j;
      continue;
    }

    out += c === " " ? " " : c;
    i += 1;
  }
  return out;
}

function isBlankLineAt(md: string, start: number): boolean {
  const end = md.indexOf("\n", start);
  return md.slice(start, end === -1 ? md.length : end).trim() === "";
}

function decodeEntity(m: RegExpExecArray): string {
  if (m[3]) return NAMED_ENTITIES[m[3]];
  const code = m[1] ? Number.parseInt(m[1], 10) : Number.parseInt(m[2], 16);
  if (code === 0xa0) return " ";
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
  return String.fromCodePoint(code);
}

/** End index of the code span starting at `start`, or the end of the backtick run if it does not close. */
function codeSpanEnd(md: string, start: number): number {
  let open = start;
  while (md[open] === "`") open += 1;
  const ticks = open - start;
  let k = open;
  while (k < md.length) {
    if (md[k] !== "`") {
      k += 1;
      continue;
    }
    let run = k;
    while (md[run] === "`") run += 1;
    if (run - k === ticks) return run;
    k = run;
  }
  return open;
}

/** `[text](destination "title")` at `start`, or null. */
function parseLink(md: string, start: number): { text: string; end: number } | null {
  // Link text: up to the matching unescaped `]`, skipping code spans.
  let depth = 0;
  let k = start + 1;
  for (; k < md.length; k += 1) {
    const c = md[k];
    if (c === "\\") k += 1;
    else if (c === "`") k = codeSpanEnd(md, k) - 1;
    else if (c === "[") depth += 1;
    else if (c === "]") {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  if (k >= md.length || md[k + 1] !== "(") return null;
  const text = md.slice(start + 1, k);

  let p = k + 2;
  while (md[p] === " " || md[p] === "\t") p += 1;
  if (md[p] === "<") {
    // <destination>: no newline, no unescaped `<`.
    p += 1;
    while (p < md.length && md[p] !== ">") {
      if (md[p] === "\n" || md[p] === "<") return null;
      p += md[p] === "\\" ? 2 : 1;
    }
    if (md[p] !== ">") return null;
    p += 1;
  } else {
    // Raw destination: no spaces, balanced parentheses.
    let parens = 0;
    while (p < md.length && !/\s/.test(md[p])) {
      if (md[p] === "\\") p += 1;
      else if (md[p] === "(") parens += 1;
      else if (md[p] === ")") {
        if (parens === 0) break;
        parens -= 1;
      }
      p += 1;
    }
  }
  while (md[p] === " " || md[p] === "\t") p += 1;
  const closer = md[p] === '"' ? '"' : md[p] === "'" ? "'" : md[p] === "(" ? ")" : null;
  if (closer) {
    p += 1;
    while (p < md.length && md[p] !== closer) p += md[p] === "\\" ? 2 : 1;
    if (md[p] !== closer) return null;
    p += 1;
    while (md[p] === " " || md[p] === "\t") p += 1;
  }
  if (md[p] !== ")") return null;
  return { text, end: p + 1 };
}
