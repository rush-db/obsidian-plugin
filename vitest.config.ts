import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // The `obsidian` package ships types only; tests run against a stub.
    alias: { obsidian: fileURLToPath(new URL('./test/obsidian-stub.ts', import.meta.url)) }
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node'
  }
})
