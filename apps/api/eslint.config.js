// apps/api/eslint.config.js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  // Ignore build + deps
  { ignores: ["dist/**", "node_modules/**"] },

  // Base JS rules
  js.configs.recommended,

  // TypeScript (non type-checked for speed)
  ...tseslint.configs.recommended,

  // Project-specific tweaks
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      strict: "off",
      "no-empty": "off",
      "@typescript-eslint/consistent-type-imports": "warn",
      //   "@typescript-eslint/no-misused-promises": [
      //     "error",
      //     { checksVoidReturn: { attributes: false } },
      //   ],
      // Add more rules here as you like
    },
  },
  {
    files: ["src/tests/**/*.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
