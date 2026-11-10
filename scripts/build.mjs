// Builds this plugin:
//   dist/index.js  — host plugin (ESM, Node). @deepseek-ai/* stay external; DSH resolves them from its own install.
//   dist/client.js — browser plugin when src/client.tsx exists, wrapped as window.__ModuleLoader__.load({ id, factory })
//                    the way DSH's own client bundles are.
//   bin/<name>     — native helper for each native/<name>.swift (macOS only; skipped elsewhere).
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

// Specifiers the browser module table answers without a dsh.client.external declaration.
const CLIENT_BASELINE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

await rm(resolve(root, 'dist'), { recursive: true, force: true })
await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(root, 'dist/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  sourcemap: 'linked',
  logLevel: 'warning',
})

if (existsSync(resolve(root, 'src/client.tsx'))) {
  const client = await build({
    entryPoints: [resolve(root, 'src/client.tsx')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    loader: { '.svg': 'text', '.png': 'dataurl' },
    external: [...CLIENT_BASELINE, ...(pkg.dsh?.client?.external ?? [])],
    logLevel: 'warning',
  })
  await writeFile(
    resolve(root, 'dist/client.js'),
    `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(pkg.name)},\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${client.outputFiles[0].text}\n    return module.exports;\n  },\n});\n`,
  )
}

const native = resolve(root, 'native')
if (existsSync(native) && process.platform === 'darwin') {
  mkdirSync(resolve(root, 'bin'), { recursive: true })
  for (const file of readdirSync(native).filter((name) => name.endsWith('.swift'))) {
    const out = resolve(root, 'bin', file.replace(/\.swift$/, ''))
    const src = resolve(native, file)
    // A helper is one script file. `// uses: <path>` lines name library sources compiled in with it.
    const text = await readFile(src, 'utf8')
    const uses = [...text.matchAll(/^\/\/ uses: (\S+)$/gm)].map((match) => resolve(root, match[1]))
    // Swift builds are slow; skip when the binary is newer than everything it is built from.
    const newest = Math.max(...[src, ...uses].map((path) => statSync(path).mtimeMs))
    if (existsSync(out) && statSync(out).mtimeMs > newest) continue
    let input = src
    if (uses.length > 0) {
      input = resolve(root, 'bin', `.${file}`)
      // Library sources go first: a script's globals are initialized in file order.
      const parts = []
      for (const path of uses) parts.push(await readFile(path, 'utf8'))
      await writeFile(input, [...parts, text].join('\n'))
    }
    try {
      execFileSync('swiftc', ['-O', '-o', out, input], { stdio: 'inherit' })
    } finally {
      if (input !== src) await rm(input, { force: true })
    }
  }
}
console.log(`built ${pkg.name}@${pkg.version}`)
