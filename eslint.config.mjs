import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "public/**", "apps/web/public/**", "apps/web/dist/**", "apps/web/.astro/**", "apps/frontend/dist/**", ".opencode/**", ".omc/**", ".agents/**", ".codex/**", ".playwright-mcp/**", "dist/**", "scripts/**", ".wrangler/**", "**/.wrangler/**", ".astro/**", "**/.astro/**", "**/__probe.test.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Cross-app imports are allowed only for SSR assertions inside tests;
  // src/ of any app must never import another app's files.
  {
    files: ["apps/*/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["../../../*", "../../../../*", "../../../../../*"], message: "No cross-app imports in src/ — shared types live in @shiba/shared." },
          ],
        },
      ],
    },
  },
);

