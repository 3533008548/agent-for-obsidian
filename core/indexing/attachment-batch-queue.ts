export interface AttachmentBatchQueueState {
  paused: boolean;
  usageDate: string;
  requestsToday: number;
  inputBytesToday: number;
  nextRequestAt?: string;
  lastProcessedPath?: string;
  lastError?: string;
}

export interface AttachmentBatchLimits {
  dailyRequestLimit: number;
  dailyInputBytesLimit: number;
  requestIntervalMs: number;
}

export type AttachmentBatchMode = "idle" | "paused" | "running" | "rate-limited" | "budget-exhausted";

export interface AttachmentBatchStatus extends AttachmentBatchQueueState {
  mode: AttachmentBatchMode;
  pending: number;
  remainingRequests: number;
  remainingInputBytes: number;
}

export interface AttachmentBatchDecision {
  allowed: boolean;
  blockedBy?: "paused" | "budget" | "rate-limit";
  reason?: string;
  waitMs?: number;
}

export const DEFAULT_ATTACHMENT_BATCH_LIMITS: AttachmentBatchLimits = {
  dailyRequestLimit: 30,
  dailyInputBytesLimit: 100 * 1024 * 1024,
  requestIntervalMs: 5_000
};

/**
 * Stores the durable, provider-cost-related part of attachment processing.
 * The actual files and their parser state stay in AttachmentIndex.
 */
export class AttachmentBatchQueue {
  private state: AttachmentBatchQueueState;
  private running = false;

  constructor(state?: Partial<AttachmentBatchQueueState>) {
    this.state = {
      paused: Boolean(state?.paused),
      usageDate: isDateKey(state?.usageDate) ? state!.usageDate! : todayKey(),
      requestsToday: clampNonNegativeInteger(state?.requestsToday),
      inputBytesToday: clampNonNegativeInteger(state?.inputBytesToday),
      nextRequestAt: normalizeIsoDate(state?.nextRequestAt),
      lastProcessedPath: state?.lastProcessedPath?.slice(0, 500),
      lastError: state?.lastError?.slice(0, 500)
    };
    this.rolloverIfNeeded();
  }

  pause(): void {
    this.state.paused = true;
  }

  resume(): void {
    this.state.paused = false;
  }

  setRunning(running: boolean): void {
    this.running = running;
  }

  isPaused(): boolean {
    return this.state.paused;
  }

  reserveAttempt(inputBytes: number, limits: AttachmentBatchLimits, now = Date.now()): AttachmentBatchDecision {
    this.rolloverIfNeeded(now);
    const normalizedBytes = clampNonNegativeInteger(inputBytes);
    if (this.state.paused) {
      return { allowed: false, blockedBy: "paused", reason: "附件批处理队列已暂停。" };
    }
    if (this.state.requestsToday >= limits.dailyRequestLimit) {
      return { allowed: false, blockedBy: "budget", reason: "已达到今日附件解析次数预算。" };
    }
    if (normalizedBytes > limits.dailyInputBytesLimit - this.state.inputBytesToday) {
      return { allowed: false, blockedBy: "budget", reason: "已达到今日附件上传体积预算。" };
    }

    const nextAt = this.state.nextRequestAt ? Date.parse(this.state.nextRequestAt) : 0;
    if (Number.isFinite(nextAt) && nextAt > now) {
      return {
        allowed: false,
        blockedBy: "rate-limit",
        reason: "附件解析正在限速等待。",
        waitMs: nextAt - now
      };
    }

    this.state.requestsToday += 1;
    this.state.inputBytesToday += normalizedBytes;
    this.state.nextRequestAt = new Date(now + limits.requestIntervalMs).toISOString();
    this.state.lastError = undefined;
    return { allowed: true };
  }

  markProcessed(path: string): void {
    this.state.lastProcessedPath = path.slice(0, 500);
    this.state.lastError = undefined;
  }

  markError(error: string): void {
    this.state.lastError = error.slice(0, 500);
  }

  getDelayMs(now = Date.now()): number {
    this.rolloverIfNeeded(now);
    const nextAt = this.state.nextRequestAt ? Date.parse(this.state.nextRequestAt) : 0;
    return Number.isFinite(nextAt) && nextAt > now ? nextAt - now : 0;
  }

  getStatus(pending: number, limits: AttachmentBatchLimits, now = Date.now()): AttachmentBatchStatus {
    this.rolloverIfNeeded(now);
    const remainingRequests = Math.max(0, limits.dailyRequestLimit - this.state.requestsToday);
    const remainingInputBytes = Math.max(0, limits.dailyInputBytesLimit - this.state.inputBytesToday);
    const exhausted = remainingRequests === 0 || remainingInputBytes === 0;
    const mode: AttachmentBatchMode = this.state.paused
      ? "paused"
      : this.running
        ? "running"
        : exhausted && pending > 0
          ? "budget-exhausted"
          : this.getDelayMs(now) > 0 && pending > 0
            ? "rate-limited"
            : "idle";
    return {
      ...this.state,
      mode,
      pending,
      remainingRequests,
      remainingInputBytes
    };
  }

  toJSON(): AttachmentBatchQueueState {
    this.rolloverIfNeeded();
    return { ...this.state };
  }

  private rolloverIfNeeded(now = Date.now()): void {
    const date = todayKey(now);
    if (this.state.usageDate === date) {
      return;
    }
    this.state.usageDate = date;
    this.state.requestsToday = 0;
    this.state.inputBytesToday = 0;
    this.state.nextRequestAt = undefined;
  }
}

function todayKey(now = Date.now()): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function normalizeIsoDate(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function clampNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
