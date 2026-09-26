import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "public/**", "apps/web/public/**", "apps/web/dist/**", "apps/web/.astro/**", "apps/frontend/dist/**", ".opencode/**", ".omc/**", ".agents/**", ".playwright-mcp/**", "dist/**", "scripts/**", ".wrangler/**", "**/.wrangler/**", ".astro/**", "**/.astro/**", "**/__probe.test.ts"] },
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
);

