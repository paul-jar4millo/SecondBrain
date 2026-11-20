// Shared lint rules for the Node.js modules. The dashboard keeps its own
// TypeScript/React configuration in dashboard/eslint.config.js.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "dashboard/**",
      "**/dist/**",
      "release/**",
      "coverage/**",
    ],
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Terminal output is parsed on purpose: ANSI escapes are expected.
      "no-control-regex": "off",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
          caughtErrors: "none",
        },
      ],
    },
  },
  // Native TypeScript (ADR 0011): only erasable syntax, explicit type imports.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.ts"],
    ignores: ["**/*.d.ts"],
  })),
  {
    files: ["**/*.ts"],
    ignores: ["**/*.d.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
          caughtErrors: "none",
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message: "Use a const object or z.enum: enums are not erasable.",
        },
        {
          selector: "TSModuleDeclaration[kind!='global']",
          message: "Namespaces are not erasable.",
        },
        {
          selector: "TSParameterProperty",
          message: "Parameter properties are not erasable.",
        },
      ],
    },
  },
];
