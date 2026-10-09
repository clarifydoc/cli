import { defineConfig } from "vitest/config";

// Scope vitest to ClarifyDoc's own source tests.
export default defineConfig({
  test: {
    // Plugins load lazily in production; tests get everything up front.
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
