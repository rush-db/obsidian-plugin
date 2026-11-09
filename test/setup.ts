import { existsSync } from 'node:fs'

// Plugin code uses `window` timers (popout-safe in Obsidian); Node has the same ones globally.
;(globalThis as { window?: unknown }).window ??= globalThis

// Integration settings (an API key, an engine URL) stay out of the shell history and the repo.
if (existsSync('.env.test')) process.loadEnvFile('.env.test')
