import { describe, expect, it } from "vitest";
import {
  AttachmentBatchQueue,
  DEFAULT_ATTACHMENT_BATCH_LIMITS
} from "../src/indexing/attachment-batch-queue";

const LIMITS = {
  ...DEFAULT_ATTACHMENT_BATCH_LIMITS,
  dailyRequestLimit: 2,
  dailyInputBytesLimit: 100,
  requestIntervalMs: 1_000
};

describe("AttachmentBatchQueue", () => {
  it("reserves budget before a provider request and applies the request interval", () => {
    const queue = new AttachmentBatchQueue();
    const now = new Date(2026, 7, 12, 10, 0, 0).getTime();

    expect(queue.reserveAttempt(40, LIMITS, now)).toEqual({ allowed: true });
    expect(queue.reserveAttempt(40, LIMITS, now + 500)).toMatchObject({
      allowed: false,
      blockedBy: "rate-limit",
      waitMs: 500
    });
    expect(queue.reserveAttempt(40, LIMITS, now + 1_000)).toEqual({ allowed: true });
    expect(queue.reserveAttempt(1, LIMITS, now + 2_000)).toMatchObject({
      allowed: false,
      blockedBy: "budget"
    });
  });

  it("enforces byte budgets, preserves pause state, and resets usage on the next day", () => {
    const now = new Date(2026, 7, 12, 10, 0, 0).getTime();
    const queue = new AttachmentBatchQueue();

    expect(queue.reserveAttempt(101, LIMITS, now)).toMatchObject({ allowed: false, blockedBy: "budget" });
    queue.pause();
    expect(queue.reserveAttempt(1, LIMITS, now)).toMatchObject({ allowed: false, blockedBy: "paused" });
    queue.resume();
    expect(queue.reserveAttempt(100, LIMITS, now)).toEqual({ allowed: true });

    const tomorrow = now + 24 * 60 * 60 * 1_000;
    expect(queue.getStatus(1, LIMITS, tomorrow)).toMatchObject({
      requestsToday: 0,
      inputBytesToday: 0,
      remainingRequests: 2,
      remainingInputBytes: 100
    });
  });

  it("reports a durable paused or budget-exhausted queue state", () => {
    const now = new Date(2026, 7, 12, 10, 0, 0).getTime();
    const queue = new AttachmentBatchQueue({ paused: true });
    expect(queue.getStatus(3, LIMITS, now).mode).toBe("paused");

    queue.resume();
    queue.reserveAttempt(10, { ...LIMITS, dailyRequestLimit: 1 }, now);
    expect(queue.getStatus(3, { ...LIMITS, dailyRequestLimit: 1 }, now + 1_000).mode).toBe("budget-exhausted");
  });
});
