/**
 * Portable runtime errors shared by every host.
 *
 * These live outside the Obsidian plugin entry so the desktop shell can reuse
 * the same agent runtime without depending on `main.ts` or the Obsidian API.
 */

/** A step cannot proceed, but the run itself is still recoverable. */
export class RuntimeToolBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeToolBlockedError";
  }
}

/**
 * Local evidence is missing or not permitted to leave the device.
 *
 * The runtime converts this into one alternative plan instead of asking the
 * user to retry the same query.
 */
export class LocalKnowledgeUnavailableError extends Error {
  constructor(
    message: string,
    readonly replanFeedback: string,
    readonly autoContinue = true
  ) {
    super(message);
    this.name = "LocalKnowledgeUnavailableError";
  }
}

export function isRuntimeBlockedError(error: unknown): boolean {
  return error instanceof RuntimeToolBlockedError;
}
