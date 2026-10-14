// @ts-check
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    name: "project/ignores",
    ignores: ["dist/", "coverage/", "load/results/"],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  security.configs.recommended,
  {
    name: "project/type-aware-parsing",
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    name: "project/rules",
    rules: {
      eqeqeq: ["error", "always"],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    // Tests create and read fixture files inside temporary directories they create themselves
    // (fs.mkdtemp under the OS temp folder); those paths are never derived from external input.
    // Production code keeps this rule enabled.
    name: "project/tests",
    files: ["tests/**/*.ts"],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },
  {
    // k6 workloads run inside k6, not Node: they read the k6 global __ENV.
    name: "project/k6",
    files: ["load/k6/**/*.js"],
    languageOptions: { globals: { __ENV: "readonly" } },
  },
  {
    // Plain JavaScript files (this config and the k6 workloads) are not part of the TypeScript
    // project, so type-aware rules cannot run on them.
    name: "project/javascript-files",
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
