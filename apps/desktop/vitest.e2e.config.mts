import { defineConfig } from "vitest/config";

// Electron 44 downloads its binary on first require, not from postinstall.
// Two workers extracting that zip at once truncate the macOS framework
// (dyld: segment __TEXT extends beyond end of file). One file at a time.
export default defineConfig({
  test: {
    include: ["test/**/*.e2e.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
