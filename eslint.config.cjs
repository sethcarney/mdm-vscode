const tsEslintPlugin = require("@typescript-eslint/eslint-plugin");
const tsEslintParser = require("@typescript-eslint/parser");

module.exports = [
  {
    ignores: ["out/**", "*.d.ts"]
  },
  ...tsEslintPlugin.configs["flat/recommended"],
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsEslintParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: "module",
        project: "./tsconfig.json"
      }
    },
    plugins: {
      "@typescript-eslint": tsEslintPlugin
    },
    rules: {
      "@typescript-eslint/naming-convention": [
        "warn",
        { selector: "import", format: ["camelCase", "PascalCase"] }
      ],
      curly: "warn",
      eqeqeq: ["warn", "always"],
      "no-throw-literal": "warn",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/explicit-function-return-type": "off"
    }
  }
];
