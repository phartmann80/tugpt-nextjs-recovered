// Shared ESLint 9 flat configuration for the TypeScript library packages
// under packages/*. apps/web keeps its own Next.js-specific flat config
// (apps/web/eslint.config.mjs) because eslint-config-next ships its own
// React/JSX/accessibility rule set that does not apply to plain TS
// libraries.
//
// Package-level eslint.config.mjs files re-export this root config so
// that `eslint .` run from inside a package resolves correctly without
// duplicating rule definitions.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/.next/**',
      '**/build/**',
      '**/coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow leading-underscore args/vars as an intentional "unused" marker,
      // otherwise keep the recommended no-unused-vars behavior.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
