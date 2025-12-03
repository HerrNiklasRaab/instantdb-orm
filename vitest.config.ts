import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    target: "es2022",
    // This ensures class fields are defined properly for MobX
    define: { "import.meta.vitest": "undefined" },
  },
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/utils/setup.ts"],
    globalSetup: ["./test/utils/globalSetup.ts"],
    testTimeout: 30000,
  },
});
