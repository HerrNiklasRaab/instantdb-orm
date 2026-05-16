import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    target: "es2017",
    define: { "import.meta.vitest": "undefined" },
  },
  test: {
    globals: true,
    include: ["test/unit/**/*.test.ts"],
  },
});
