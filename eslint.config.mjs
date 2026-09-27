import tseslint from "typescript-eslint";

// ESLint is kept for a single rule with no Biome equivalent:
// no-restricted-imports enforces the apps/src import boundary.
// Formatting and file-level linting are owned by Biome (biome.json).
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "public/**",
      "apps/web/public/**",
      "apps/web/dist/**",
      "apps/web/.astro/**",
      "apps/frontend/dist/**",
      ".opencode/**",
      ".omc/**",
      ".agents/**",
      ".codex/**",
      ".playwright-mcp/**",
      "dist/**",
      "scripts/**",
      ".wrangler/**",
      "**/.wrangler/**",
      ".astro/**",
      "**/.astro/**",
      "**/__probe.test.ts",
    ],
  },
  // Cross-app imports are allowed only for SSR assertions inside tests;
  // src/ of any app must never import another app's files.
  {
    files: ["apps/*/src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../../*", "../../../../*", "../../../../../*"],
              message: "No cross-app imports in src/ — shared types live in @shiba/shared.",
            },
          ],
        },
      ],
    },
  },
  // packages/* are the leaf layer: they must never reach into apps/.
  {
    files: ["packages/*/src/**/*.{ts,tsx}", "packages/*/test/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../../apps/**", "../../../apps/**", "*/apps/*/**"],
              message: "Packages must not import apps/ — shared contracts live in @shiba/shared.",
            },
          ],
        },
      ],
    },
  },
);
