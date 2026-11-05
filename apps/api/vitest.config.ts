import { defineConfig } from "vitest/config";

export default defineConfig({
  // Files run one after another: the Nanite-wide mail quota counts rows written by every test file.
  test: { include: ["test/**/*.test.ts"], testTimeout: 15_000, fileParallelism: false },
});
