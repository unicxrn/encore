import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginSvelte from 'eslint-plugin-svelte'

export default defineConfig(
  // `.worktrees` is where a nested checkout goes when one is used. Without ignoring it, a
  // half-written file in a sibling working copy turns the main tree's lint red while the main
  // tree is clean, which is a confusing way to lose an afternoon.
  { ignores: ['**/node_modules', '**/dist', '**/out', '.worktrees/**'] },
  tseslint.configs.recommended,
  eslintPluginSvelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{tsx,svelte}'],
    rules: {
      'svelte/no-unused-svelte-ignore': 'off'
    }
  },
  // The release tooling in `scripts/` is plain JavaScript, run straight by node with no build
  // step of its own, so there is no syntax in the file for a return type to be written in. The
  // rule is a TypeScript rule and has nothing to check here.
  {
    files: ['scripts/**/*.{js,mjs,cjs}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
