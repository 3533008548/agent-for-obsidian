import { describe, expect, it } from "vitest";
import { createJsonFieldExtractor } from "../core/services/json-answer-stream";

function drain(chunks: string[], field = "answer"): { text: string; closed: boolean } {
  const extractor = createJsonFieldExtractor(field);
  let text = "";
  for (const chunk of chunks) {
    text += extractor.push(chunk);
  }
  return { text, closed: extractor.closed };
}

function splitEvenly(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

describe("createJsonFieldExtractor", () => {
  it("extracts the field value from a complete document", () => {
    const result = drain(['{"answer":"已证实部分","evidenceComplete":true}']);
    expect(result.text).toBe("已证实部分");
    expect(result.closed).toBe(true);
  });

  it("yields text progressively as chunks arrive", () => {
    const extractor = createJsonFieldExtractor("answer");
    expect(extractor.push('{"answer":"第一段')).toBe("第一段");
    expect(extractor.push("，第二段")).toBe("，第二段");
    expect(extractor.push('"')).toBe("");
  });

  it("never repeats text already emitted", () => {
    const document = '{"answer":"abcdefghij","evidenceComplete":false}';
    expect(drain(splitEvenly(document, 3)).text).toBe("abcdefghij");
    expect(drain(splitEvenly(document, 1)).text).toBe("abcdefghij");
  });

  it("decodes escape sequences split across chunk boundaries", () => {
    const raw = '{"answer":"第一行\\n第二行"}';
    expect(drain(splitEvenly(raw, 4)).text).toBe("第一行\n第二行");
  });

  it("holds back a trailing backslash until the escape completes", () => {
    const extractor = createJsonFieldExtractor("answer");
    expect(extractor.push('{"answer":"abc\\')).toBe("abc");
    expect(extractor.push("n")).toBe("\n");
    expect(extractor.push('def"}')).toBe("def");
  });

  it("decodes unicode escapes split across chunk boundaries", () => {
    const raw = '{"answer":"中文\\u4e2d\\u6587"}';
    expect(drain(splitEvenly(raw, 5)).text).toBe("中文中文");
  });

  it("keeps escaped quotes inside the value", () => {
    const result = drain(['{"answer":"他说\\"你好\\""}']);
    expect(result.text).toBe('他说"你好"');
    expect(result.closed).toBe(true);
  });

  it("finds the field regardless of key order", () => {
    const result = drain(['{"evidenceComplete":true,"answer":"后续字段"}']);
    expect(result.text).toBe("后续字段");
  });

  it("ignores a field name appearing as a value", () => {
    const result = drain(['{"label":"answer","answer":"真正的回答"}']);
    expect(result.text).toBe("真正的回答");
  });

  it("tolerates a Markdown code fence around the document", () => {
    const result = drain(['```json\n{"answer":"带栅栏","evidenceComplete":true}\n```']);
    expect(result.text).toBe("带栅栏");
  });

  it("returns nothing before the field appears", () => {
    const extractor = createJsonFieldExtractor("answer");
    expect(extractor.push('{"evidence')).toBe("");
    expect(extractor.push("Complete\":true,")).toBe("");
    expect(extractor.push('"answer":"终于到了')).toBe("终于到了");
  });

  it("stops emitting once the value is closed", () => {
    const extractor = createJsonFieldExtractor("answer");
    extractor.push('{"answer":"结束","evidenceComplete":true}');
    expect(extractor.push('"answer":"不应再出现"')).toBe("");
  });

  it("extracts a custom field name", () => {
    expect(drain(['{"summary":"概要内容"}'], "summary").text).toBe("概要内容");
  });
});
