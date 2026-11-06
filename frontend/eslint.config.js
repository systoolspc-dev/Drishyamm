import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: { react },
    settings: { react: { version: 'detect' } },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],

      // Core `no-undef` cannot see JSX: espree's scope analyser does not
      // register a JSXIdentifier as a variable reference, so `<Foo/>` with no
      // import for Foo lints clean and then throws `Foo is not defined` at
      // render time — in whichever branch happens to execute. This is exactly
      // how afb12ac shipped: it swapped Sparkles -> GraduationCap in the
      // FaceLearning import list while a second <Sparkles/> ~490 lines below
      // still referenced the binding. These two rules are the only thing that
      // makes an import list and its JSX usages verifiable against each other.
      'react/jsx-no-undef': 'error',
      // Counterpart: marks components referenced ONLY from JSX as used, so
      // no-unused-vars stops needing varsIgnorePattern to stay quiet.
      'react/jsx-uses-vars': 'error',
    },
  },
  {
    // Build-time config files run in Node, not the browser: `__dirname` (path
    // alias) and `process.env` (the ANALYZE=1 gate on the bundle visualizer)
    // are legal here and only here. Application code under src/ keeps the
    // browser-only globals, so a stray `process.env` in a component still errors.
    files: ['*.config.js', 'vite.config.js', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
])
