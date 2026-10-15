/**
 * The pieces of the renderer that are pure enough to test.
 *
 * The desktop shell renders Markdown itself rather than pulling in a library,
 * which means the parts that decide what a line *is* have to be right: notes
 * carry machine state that must not reach the reader, and every generated
 * report is built from tables and callouts.
 */

export const CALLOUT_LABELS: Record<string, string> = {
  note: "注释",
  abstract: "摘要",
  summary: "摘要",
  info: "信息",
  tip: "提示",
  hint: "提示",
  important: "重要",
  warning: "警告",
  caution: "警告",
  danger: "危险",
  error: "错误",
  question: "疑问",
  example: "示例",
  quote: "引用",
  success: "结论",
  failure: "注意"
};

/**
 * Makes a locator readable.
 *
 * Chunk locators are percent-encoded to stay stable index keys
 * (`heading=%E7%8A%B6%E6%80%81&chunk=1`) — right for storage, wrong for prose.
 * Notes already on disk carry the encoded form, so reading has to undo it
 * rather than waiting for the file to be rewritten.
 */
function humanizeLocators(text: string): string {
  return text.replace(/heading=([^\s，。；）】、|]+)/g, (whole, locator: string) => {
    try {
      return `heading=${decodeURIComponent(locator)}`;
    } catch {
      return whole;
    }
  });
}

/**
 * Removes what a human should never have to read.
 *
 * Notes carry machine state: YAML frontmatter, and HTML comment blocks holding
 * source hashes. None of it is meant to be read, so this renderer strips both or
 * every Wiki page opens with a wall of JSON.
 */
export function stripMachineNoise(content: string): string {
  const text = content.replace(/\r\n?/g, "\n");
  let start = 0;
  const firstLine = text.split("\n")[0] ?? "";
  if (/^---\s*$/.test(firstLine)) {
    const closing = /\n---[ \t]*(\n|$)/.exec(text.slice(3));
    if (closing) {
      start = 3 + closing.index + closing[0].length;
    }
  }
  // Comment removal has to skip fenced code, or a sample containing "<!--"
  // would lose half its body.
  const withoutComments = text
    .slice(start)
    .replace(/^\s*\n/, "")
    .split(/(```[\s\S]*?(?:```|$))/g)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/<!--[\s\S]*?-->/g, "")))
    .join("");
  return humanizeLocators(withoutComments);
}

export function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 1;
}

export function isTableDivider(line: string): boolean {
  return isTableRow(line) && /^[\s|:-]+$/.test(line);
}

export function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export interface ParsedCallout {
  kind: string;
  title: string;
}

/** Recognises an Obsidian-style callout opener such as `> [!warning]- 标题`. */
export function parseCalloutHead(line: string): ParsedCallout | null {
  const match = /^\[!([a-zA-Z]+)\][+-]?\s*(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  return { kind: match[1]!.toLowerCase(), title: match[2]!.trim() };
}

export interface ParsedBullet {
  depth: number;
  ordered: boolean;
  text: string;
}

export function parseBullet(line: string): ParsedBullet | null {
  const match = /^(\s*)([-*+]|\d+\.)\s+(.+)$/.exec(line);
  if (!match) {
    return null;
  }
  const indent = match[1]!.replace(/\t/g, "  ").length;
  return {
    depth: Math.floor(indent / 2),
    ordered: /\d/.test(match[2]!),
    text: match[3]!
  };
}

/**
 * True for a line that continues the list item above it rather than starting
 * anything new.
 *
 * Only indentation distinguishes the two, which is the same rule Markdown
 * itself uses: a bare `1. **标题**` followed by a plain line is a new
 * paragraph, but that line indented belongs to the item. Models rely on this
 * constantly — "1. **没有拥塞控制**" then an indented explanation — and
 * without it the explanation renders as a stray paragraph *and* the list ends,
 * so the following item opens a new list numbered from 1 again.
 */
export function isIndentedContinuation(line: string): boolean {
  if (!line.trim() || parseBullet(line)) {
    return false;
  }
  return /^(?: {2,}|\t)/.test(line);
}

/** True for lines that start a block, i.e. lines that end a paragraph. */
export function isBlockStart(line: string): boolean {
  return (
    line.startsWith("#") ||
    line.startsWith(">") ||
    line.trimStart().startsWith("```") ||
    isTableRow(line) ||
    /^\s{0,3}(?:[-*+]|\d+\.)\s+/.test(line) ||
    /^[-*_]{3,}\s*$/.test(line.trim())
  );
}
