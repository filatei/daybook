// ESLint flat config — Daybook.
// Goal: catch the *bug* classes cheaply (undefined vars, redeclare/shadow, dupe
// keys, bad hooks, unreachable code) without drowning in style noise. Formatting
// is owned by Prettier (eslint-config-prettier turns the conflicting rules off).
// Wired into CI as non-blocking first; tighten to blocking once warnings are cleared.
'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');
const prettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: [
      'node_modules/**', 'dist/**', 'frontend/dist/**', 'frontend/src/public/**',
      'infra/**', 'docs/**', 'scripts/**', 'backend/data/**',
      'frontend/app.js',   // legacy pre-React single-file SPA (superseded by frontend/src)
      '**/*.min.js', 'eslint.config.js',
    ],
  },

  js.configs.recommended,

  // ── Backend — Node / CommonJS ──────────────────────────────────────────────
  {
    files: ['backend/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true, caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
    },
  },

  // ── Frontend — Browser / ESM / React ───────────────────────────────────────
  {
    files: ['frontend/src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2021, google: 'readonly', Chart: 'readonly' },
    },
    settings: { react: { version: '18' } },
    rules: {
      // Hooks correctness — these prevent real, subtle React bugs.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Components defined INSIDE another component's render get a new identity
      // every render → React remounts them → inputs lose focus / flicker (the
      // Day-ops "one number at a time" bug). Error so it can never ship again.
      'react/no-unstable-nested-components': ['error', { allowAsProps: true }],
      'react/jsx-key': 'warn',
      'react/jsx-no-undef': 'error',
      'react/no-unknown-property': 'warn',
      'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true, caughtErrors: 'none', varsIgnorePattern: '^React$' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['warn', { checkLoops: false }],
    },
  },

  // ── Service worker (browser + SW globals, classic script) ──────────────────
  {
    files: ['frontend/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.serviceworker, ...globals.browser },
    },
    rules: { 'no-unused-vars': 'warn' },
  },

  // ── High-value correctness rules everywhere ────────────────────────────────
  {
    files: ['backend/**/*.js', 'frontend/src/**/*.{js,jsx}', 'frontend/sw.js'],
    rules: {
      'no-control-regex': 'off',
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-cond-assign': ['error', 'always'],
      'no-self-assign': 'error',
      'no-undef': 'error',
    },
  },

  prettier,
];
