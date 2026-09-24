import { defineConfig } from "vitest/config";

/**
 * Separate from vite.config.ts, whose `root` points at the Electron renderer.
 * Unit tests cover the shared kernel and the desktop services.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node"
  }
});
