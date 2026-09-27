/**
 * Incrementally extracts a single string field from a partially received JSON
 * document.
 *
 * Knowledge answers are requested in JSON mode so the model can also report
 * `evidenceComplete` / `missingEvidence`. Streaming that response verbatim would
 * show the user raw JSON syntax, so instead we decode the `answer` value as its
 * characters arrive and hand back only the newly revealed text.
 *
 * The extractor is a pure accumulator: feed it chunks in arrival order and it
 * returns the text that became displayable since the previous call. Incomplete
 * escape sequences are held back until the following chunk completes them, so
 * callers never see a dangling backslash.
 */
export interface JsonFieldExtractor {
  /** Feeds the next raw chunk and returns newly decoded text. */
  push(chunk: string): string;
  /** True once the field value has been closed by an unescaped quote. */
  readonly closed: boolean;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  "\"": "\"",
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t"
};

export function createJsonFieldExtractor(field: string): JsonFieldExtractor {
  const keyPattern = `"${field}"`;
  let buffer = "";
  let cursor = -1;
  let decoded = "";
  let emitted = 0;
  let isClosed = false;

  function locateKey(): boolean {
    for (let index = buffer.indexOf(keyPattern); index !== -1; index = buffer.indexOf(keyPattern, index + 1)) {
      let position = index + keyPattern.length;
      while (position < buffer.length && isWhitespace(buffer[position])) {
        position += 1;
      }
      if (buffer[position] !== ":") {
        continue;
      }
      position += 1;
      while (position < buffer.length && isWhitespace(buffer[position])) {
        position += 1;
      }
      // The opening quote may still be in a future chunk; report "not ready".
      if (position >= buffer.length) {
        return false;
      }
      if (buffer[position] !== "\"") {
        continue;
      }
      cursor = position + 1;
      return true;
    }
    return false;
  }

  function consume(): string {
    while (cursor < buffer.length) {
      const character = buffer[cursor];
      if (character === "\"") {
        isClosed = true;
        cursor += 1;
        break;
      }
      if (character === "\\") {
        if (cursor + 1 >= buffer.length) {
          break;
        }
        const escape = buffer[cursor + 1];
        if (escape === "u") {
          if (cursor + 6 > buffer.length) {
            break;
          }
          const hex = buffer.slice(cursor + 2, cursor + 6);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
            decoded += escape;
            cursor += 2;
            continue;
          }
          decoded += decodeCodeUnit(hex);
          cursor += 6;
          continue;
        }
        decoded += SIMPLE_ESCAPES[escape] ?? escape;
        cursor += 2;
        continue;
      }
      decoded += character;
      cursor += 1;
    }
    const fresh = decoded.slice(emitted);
    emitted = decoded.length;
    return fresh;
  }

  return {
    push(chunk: string): string {
      if (isClosed || !chunk) {
        return "";
      }
      buffer += chunk;
      if (cursor < 0 && !locateKey()) {
        return "";
      }
      return consume();
    },
    get closed(): boolean {
      return isClosed;
    }
  };
}

function isWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}

function decodeCodeUnit(hex: string): string {
  try {
    return JSON.parse(`"\\u${hex}"`) as string;
  } catch {
    return "";
  }
}
