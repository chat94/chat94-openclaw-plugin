import { defineConfig, defineWorkspace } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: "contract",
          include: ["tests/contract/**/*.test.ts"],
          testTimeout: 15_000,
        },
      },
    ],
  },
});
