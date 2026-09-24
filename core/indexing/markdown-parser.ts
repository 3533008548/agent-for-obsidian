import type { SourceRef } from "../domain/source-ref";
import { hashText } from "../domain/content-hash";

const MAX_CHUNK_CHARACTERS = 2_400;
const PARSER_VERSION = "markdown-v1";

export interface MarkdownChunk {
  source: SourceRef;
  content: string;
  heading: string | null;
  headingPath: string[];
  startLine: number;
  endLine: number;
}

export function parseMarkdownIntoChunks(path: string, markdown: string): MarkdownChunk[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const chunks: MarkdownChunk[] = [];
  const headingStack: string[] = [];
  let currentLines: string[] = [];
  let currentHeading: string | null = null;
  let currentHeadingPath: string[] = [];
  let startLine = 1;

  const flush = (endLine: number): void => {
    const text = currentLines.join("\n").trim();
    if (!text) {
      return;
    }

    splitIntoSizedChunks(text).forEach((content, index) => {
      const locator = currentHeading
        ? `heading=${encodeURIComponent(currentHeading)}&chunk=${index + 1}`
        : `chunk=${index + 1}`;
      chunks.push({
        source: {
          type: "note",
          pathOrUrl: path,
          locator,
          contentHash: hashText(content),
          parserVersion: PARSER_VERSION
        },
        content,
        heading: currentHeading,
        headingPath: [...currentHeadingPath],
        startLine,
        endLine
      });
    });
  };

  lines.forEach((line, index) => {
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!headingMatch) {
      currentLines.push(line);
      return;
    }

    flush(index);
    const level = headingMatch[1].length;
    const title = headingMatch[2].trim();
    headingStack.length = level - 1;
    headingStack[level - 1] = title;
    currentHeading = title;
    currentHeadingPath = headingStack.filter(Boolean);
    currentLines = [line];
    startLine = index + 1;
  });

  flush(lines.length);
  return chunks;
}

function splitIntoSizedChunks(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARACTERS) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\s*\n/)) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= MAX_CHUNK_CHARACTERS) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    for (let offset = 0; offset < paragraph.length; offset += MAX_CHUNK_CHARACTERS) {
      const part = paragraph.slice(offset, offset + MAX_CHUNK_CHARACTERS);
      if (part.length === MAX_CHUNK_CHARACTERS) {
        chunks.push(part);
      } else {
        current = part;
      }
    }
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}
