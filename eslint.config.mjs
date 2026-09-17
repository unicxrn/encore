import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginSvelte from 'eslint-plugin-svelte'

export default defineConfig(
  // These mirror .gitignore's directories, because flat config does not read .gitignore: a
  // scratch or tool directory holding one .js file turns the lint gate red over a file nobody
  // wrote. `.worktrees` is a nested checkout, so a half-written file in a sibling copy would
  // fail the main tree while the main tree is clean. `.build-tmp` is the one that actually
  // bites: CLAUDE.md points TMPDIR at it, and the measure scripts write a generated
  // preload.cjs into the temp directory they make there.
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '.worktrees/**',
      '.build-tmp/**',
      '.dev-userdata/**',
      '.serena/**',
      '.agents/**',
      '.claude/skills/**',
      'notes/**'
    ]
  },
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
