import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: ["out", "dist", "**/*.d.ts", "node_modules"],
  },
  {
    rules: {
      "@typescript-eslint/naming-convention": "off",
      curly: "warn",
      eqeqeq: "warn",
      "no-throw-literal": "warn",
      // This codebase integrates several dynamically imported SDKs whose
      // runtime surfaces are intentionally untyped. Keep lint actionable;
      // strict project compilation remains the type-safety release gate.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-case-declarations": "off",
    },
  },
  {
    files: ["test/**/*.ts", "packages/*/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
      "no-unused-expressions": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
