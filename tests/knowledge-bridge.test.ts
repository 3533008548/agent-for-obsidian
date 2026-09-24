import { describe, expect, it } from "vitest";
import { BridgeError, BRIDGE_API_VERSION, parseRequest } from "../src/bridge-schema";

/**
 * 双向契约的「知识库侧」：当工作台（Python）给请求加一个字段，这里必须立刻
 * 拒绝。另一侧（工作台拒绝响应字段漂移）由 workstation 的 pytest 覆盖。
 *
 * 这里只测 `parseRequest` 的严格性——检索本身由 core/ 的既有单测覆盖。
 */

describe("knowledge-bridge/1 request contract (strict)", () => {
  const valid = {
    apiVersion: BRIDGE_API_VERSION,
    mode: "search",
    vault: "D:/vault",
    query: "hello",
    limit: 5,
    scope: null,
  } as const;

  it("accepts a well-formed request", () => {
    const req = parseRequest({ ...valid });
    expect(req.apiVersion).toBe(BRIDGE_API_VERSION);
    expect(req.mode).toBe("search");
    expect(req.vault).toBe("D:/vault");
    expect(req.query).toBe("hello");
    expect(req.limit).toBe(5);
    expect(req.scope).toBeNull();
  });

  it("rejects unknown keys (drift from the base side)", () => {
    let caught: BridgeError | null = null;
    try {
      parseRequest({ ...valid, brandNewField: true });
    } catch (error) {
      caught = error as BridgeError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe("CONTRACT_DRIFT");
  });

  it("rejects a wrong apiVersion", () => {
    expect(() => parseRequest({ ...valid, apiVersion: "ppt-bridge/1" })).toThrow();
  });

  it("rejects a relative (non-absolute) vault", () => {
    expect(() => parseRequest({ ...valid, vault: "relative/vault" })).toThrow();
  });

  it("rejects an empty/whitespace query", () => {
    expect(() => parseRequest({ ...valid, query: "   " })).toThrow();
  });

  it("rejects a non-positive or non-integer limit", () => {
    expect(() => parseRequest({ ...valid, limit: 1.5 })).toThrow();
    expect(() => parseRequest({ ...valid, limit: 0 })).toThrow();
  });

  it("rejects an unsupported mode", () => {
    expect(() => parseRequest({ ...valid, mode: "write" })).toThrow();
  });
});
