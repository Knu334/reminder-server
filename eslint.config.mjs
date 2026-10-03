import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/.terraform/**", "**/.devcontainer/**", "**/.superpowers/**"] },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [pluginJs.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"],
    extends: [pluginJs.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": ["error", {
        args: "all", argsIgnorePattern: "^_", caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_",
        varsIgnorePattern: "^_", ignoreRestSiblings: true,
      }],
    },
  },
  {
    // Temporary Express HTTPS listener compatibility; removed with the legacy app in R08.
    files: ["src/app.ts"],
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
    },
  },
);
