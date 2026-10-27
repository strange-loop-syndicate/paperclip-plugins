/**
 * The comment editor's store path, for tests: MDXEditor serializes with
 * mdast-util-to-markdown (mdx-jsx, strikethrough and `==highlight==` rules,
 * `listItemIndent: "one"`), trims, then Paperclip's `toStoredMarkdown`
 * un-escapes line-start `\>` and `\<` before a tag-like character.
 * Read from the installed Paperclip UI bundle (MarkdownEditor-*.js), SLS-194.
 */
import type { PhrasingContent, RootContent } from "mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import { mdxJsxToMarkdown } from "mdast-util-mdx-jsx";
import { gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";

const FULL_PHRASING_SPANS = ["autolink", "destinationLiteral", "destinationRaw", "reference", "titleQuote", "titleApostrophe"];
const highlightToMarkdown = {
  unsafe: [{ character: "=", inConstruct: "phrasing" as const, notInConstruct: FULL_PHRASING_SPANS as never }],
};

/** Stored body for typed text: each line is a paragraph (Enter), as the editor makes it. */
export function storeTyped(typed: string): string {
  return storeBlocks(typed.split("\n").map((line) => paragraph(line ? [{ type: "text", value: line }] : [])));
}

export function paragraph(children: PhrasingContent[]): RootContent {
  return { type: "paragraph", children };
}

export function storeBlocks(children: RootContent[]): string {
  const md = toMarkdown(
    { type: "root", children },
    { extensions: [mdxJsxToMarkdown(), gfmStrikethroughToMarkdown(), highlightToMarkdown], listItemIndent: "one" },
  );
  return toStoredMarkdown(`${md}\n`.trim());
}

// Paperclip `toStoredMarkdown` (unescapeBlockquoteMarkers + unescapeAngleBracketEscapes), outside code.
const AUTOLINK = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>\x00-\x1f]*>/;
const EMAIL = /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/;

function toStoredMarkdown(md: string): string {
  let fence = "";
  return md
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = "";
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      return unescapeAngles(line.replace(/^( {0,3})\\>/, "$1>"));
    })
    .join("\n");
}

function unescapeAngles(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; ) {
    if (line[i] === "`") {
      let n = 1;
      while (line[i + n] === "`") n += 1;
      const close = line.indexOf("`".repeat(n), i + n);
      const end = close === -1 ? i + n : close + n;
      out += line.slice(i, end);
      i = end;
    } else if (line[i] === "\\") {
      const rest = line.slice(i + 1);
      if (rest[0] === "<" && /[A-Za-z!/?]/.test(rest[1] ?? "") && !AUTOLINK.test(rest) && !EMAIL.test(rest)) out += "<";
      else out += line.slice(i, i + 2);
      i += 2;
    } else out += line[i++];
  }
  return out;
}
