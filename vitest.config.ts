import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 10000,
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
    },
    resolve: {
      extensions: [".ts", ".js"],
    },
    alias: {
      // Allow importing .js extensions to resolve to .ts source files
      "^(\\.\\.?/.*)\\.js$": "$1",
    },
  },
});
