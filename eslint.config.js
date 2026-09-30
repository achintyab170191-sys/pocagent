import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import reactHooks from 'eslint-plugin-react-hooks';

export default [
  // Global ignores: build output, generated artifacts, browser-test output, scratch space.
  { ignores: ['**/node_modules/**', '**/dist/**', 'coverage/**', 'artifacts/**', 'playwright-report/**', 'test-results/**', 'scratch/**', 'uploads/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['apps/web/**/*.{ts,tsx}'], plugins: { 'react-hooks': reactHooks }, rules: reactHooks.configs.recommended.rules },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
];
