import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "qc", "query"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Les variables préfixées par _ sont volontairement inutilisées (ex. extraction de champs à écarter).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": ["warn", { allow: ["error", "info"] }],
    },
  },
  { files: ["src/types/**/*.d.ts"], rules: { "@typescript-eslint/no-namespace": "off" } },
);
