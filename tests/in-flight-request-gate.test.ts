import { describe, expect, it } from "vitest";
import { InFlightRequestGate } from "../src/services/in-flight-request-gate";

describe("in-flight request gate", () => {
  it("reuses an active request with the same key and releases it afterward", async () => {
    const gate = new InFlightRequestGate();
    let runs = 0;
    let release: ((value: string) => void) | undefined;
    const operation = () => new Promise<string>((resolve) => {
      runs += 1;
      release = resolve;
    });

    const first = gate.run("same", operation);
    const second = gate.run("same", operation);
    await Promise.resolve();
    expect(runs).toBe(1);

    release?.("done");
    await expect(first).resolves.toBe("done");
    await expect(second).resolves.toBe("done");

    await expect(gate.run("same", async () => {
      runs += 1;
      return "next";
    })).resolves.toBe("next");
    expect(runs).toBe(2);
  });
});
