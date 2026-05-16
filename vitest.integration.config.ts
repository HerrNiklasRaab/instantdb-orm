import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    target: "es2017",
    define: { "import.meta.vitest": "undefined" },
  },
  test: {
    globals: true,
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["./test/integration/support/globalSetup.ts"],
    testTimeout: 30000,
  },
});
