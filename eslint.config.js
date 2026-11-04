import js from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "qc", "query", ".github"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // SAST : règles de sécurité (injection, regex dangereuses, comparaisons non sûres, accès dynamiques…).
  security.configs.recommended,
  {
    rules: {
      // Les variables préfixées par _ sont volontairement inutilisées (ex. extraction de champs à écarter).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": ["warn", { allow: ["error", "info"] }],
    },
  },
  {
    rules: {
      // Règle désactivée après tri de TOUTES ses alertes (voir docs/SAST-ET-IMAGE-DOCKER.md §3) : elle signale tout `obj[clé]`,
      // même quand la clé est un littéral, une énumération validée ou un entier aléatoire. 100 % de faux positifs ici,
      // et le bruit masquerait les vraies alertes. Les autres règles de sécurité restent actives.
      "security/detect-object-injection": "off",
    },
  },
  // Scripts d'administration lancés à la main (chemins fixes) et tests : les règles fs/regex n'y ont pas de sens.
  { files: ["src/scripts/**", "test/**"], rules: { "security/detect-non-literal-fs-filename": "off", "security/detect-non-literal-regexp": "off" } },
  { files: ["src/types/**/*.d.ts"], rules: { "@typescript-eslint/no-namespace": "off" } },
);
