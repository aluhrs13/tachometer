import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import noOnlyTests from 'eslint-plugin-no-only-tests';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'lib/',
      'client/lib/',
      'src/test/data/',
      'config.schema.json',
      'eslint.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'no-only-tests': noOnlyTests,
    },
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-constant-condition': 'off',
      'no-empty': 'off',
      'no-only-tests/no-only-tests': 'error',
    },
  }
);
