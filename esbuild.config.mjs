import { builtinModules } from 'node:module'
import esbuild from 'esbuild'

const prod = process.argv[2] === 'production'

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  // Obsidian provides these at runtime; everything else is bundled into main.js.
  external: [
    'obsidian',
    'electron',
    '@codemirror/*',
    '@lezer/*',
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`)
  ],
  format: 'cjs',
  // Browser conditions select the SDK's fetch build, never its Node one, so the
  // bundle also runs on mobile.
  platform: 'browser',
  target: 'es2020',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  minify: prod,
  outfile: 'main.js'
})

if (prod) {
  await context.rebuild()
  await context.dispose()
} else {
  await context.watch()
}
