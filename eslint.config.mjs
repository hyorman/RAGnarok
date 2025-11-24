import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["out", "dist", "**/*.d.ts", "node_modules"],
  },
  {
    rules: {
      "@typescript-eslint/naming-convention": "off",
      "curly": "warn",
      "eqeqeq": "warn",
      "no-throw-literal": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "no-case-declarations": "off"
    }
  }
);
