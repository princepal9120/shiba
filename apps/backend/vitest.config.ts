import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  plugins: [
    {
      name: "cloudflare-scheme-stub",
      // `cloudflare:*` specifiers (pulled in transitively by agents/mcp)
      // are unresolvable under Node — evaluate a benign stub instead.
      resolveId: (id: string) =>
        id.startsWith("cloudflare:")
          ? `${import.meta.dirname}/test/cloudflare-stub.ts`
          : null,
    },
  ],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    server: {
      deps: {
        // agents/mcp transitively imports cloudflare:* specifiers, which
        // Node's ESM loader cannot resolve — inlining routes them through
        // Vite so the resolveId stub above applies.
        inline: ["agents", "@cloudflare/codemode"],
      },
    },
  },
});
