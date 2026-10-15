import { beforeEach, describe, expect, it } from "vitest";

import {
  enqueueMermaidRender,
  nextMermaidDiagramId,
  resetMermaidRenderState
} from "../src/renderer/mermaid-render-queue";

describe("mermaid render queue", () => {
  beforeEach(() => {
    resetMermaidRenderState();
  });

  it("never hands out the same id twice", () => {
    const ids = Array.from({ length: 50 }, () => nextMermaidDiagramId());
    expect(new Set(ids).size).toBe(50);
  });

  it("runs renders one after another instead of overlapping", async () => {
    const events: string[] = [];
    const makeTask = (name: string, duration: number) => async () => {
      events.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, duration));
      events.push(`${name}:end`);
      return name;
    };

    const results = await Promise.all([
      enqueueMermaidRender(makeTask("a", 20)),
      enqueueMermaidRender(makeTask("b", 1))
    ]);

    expect(results).toEqual(["a", "b"]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("keeps the queue usable after a render fails", async () => {
    const failed = enqueueMermaidRender(async () => {
      throw new Error("boom");
    });
    const after = enqueueMermaidRender(async () => "ok");

    await expect(failed).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
  });
});
