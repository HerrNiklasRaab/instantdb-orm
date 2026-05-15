import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    target: "es2017",
    // This ensures class fields are defined properly for MobX
    define: { "import.meta.vitest": "undefined" },
  },
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/integration/support/globalSetup.ts"],
    testTimeout: 30000,
  },
});
