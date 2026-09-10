import { describe, expect, it, vi } from "vitest";
import { DeepSeekVisionClient } from "../src/services/deepseek-vision-client";

describe("DeepSeekVisionClient", () => {
  it("sends a DeepSeek vision-compatible image_url block", async () => {
    const postJson = vi.fn().mockResolvedValue({ choices: [{ message: { content: "图片中的架构图。" } }] });
    const client = new DeepSeekVisionClient({
      apiKey: "key",
      model: "deepseek-v4-flash-vision-exp",
      slowResponseMs: 60_000,
      postJson
    });

    await expect(client.describeImage("aGVsbG8=", "image/png")).resolves.toEqual({
      content: "图片中的架构图。",
      parserVersion: "deepseek-vision-v1"
    });
    expect(postJson).toHaveBeenCalledWith(expect.objectContaining({
      providerName: "DeepSeek Vision",
      payload: expect.objectContaining({
        model: "deepseek-v4-flash-vision-exp",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } })
            ])
          })
        ])
      })
    }));
  });
});
