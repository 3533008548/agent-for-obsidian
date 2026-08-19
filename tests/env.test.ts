import { describe, expect, it } from "vitest";
import { ENV_TEMPLATE, readEnvValue } from "../src/services/env";

describe("local env parsing", () => {
  it("reads a key without returning comments or surrounding quotes", () => {
    const contents = [
      "# local only",
      "GLM_API_KEY = \"secret-value\"",
      "OTHER=value"
    ].join("\n");

    expect(readEnvValue(contents, "GLM_API_KEY")).toBe("secret-value");
    expect(readEnvValue(contents, "MISSING")).toBeNull();
  });

  it("provides an editable template without a real key", () => {
    expect(ENV_TEMPLATE).toContain("DEEPSEEK_API_KEY=");
    expect(ENV_TEMPLATE).toContain("GLM_API_KEY=");
    expect(ENV_TEMPLATE).toContain("TAVILY_API_KEY=");
    expect(readEnvValue(ENV_TEMPLATE, "DEEPSEEK_API_KEY")).toBeNull();
    expect(readEnvValue(ENV_TEMPLATE, "GLM_API_KEY")).toBeNull();
    expect(readEnvValue(ENV_TEMPLATE, "TAVILY_API_KEY")).toBeNull();
  });
});
