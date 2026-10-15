export type SourceType = "note" | "pdf" | "image" | "web" | "conversation";

export interface SourceRef {
  type: SourceType;
  pathOrUrl: string;
  locator: string;
  contentHash: string;
  parserVersion: string;
  retrievedAt?: string;
}

/**
 * Makes a locator readable.
 *
 * Chunk locators are percent-encoded so they stay stable index keys
 * (`heading=%E7%8A%B6%E6%80%81&chunk=1`). Right form for storage, wrong form
 * for a page meant to be read, so anything rendering one into prose runs it
 * through here first.
 */
export function humanizeLocator(locator: string): string {
  if (!locator.includes("%")) {
    return locator;
  }
  try {
    return decodeURIComponent(locator);
  } catch {
    // A stray "%" that is not a valid escape still beats nothing.
    return locator;
  }
}
