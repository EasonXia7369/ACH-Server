import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 打包自托管服务端：src（Workers 版 Hono 应用）+ selfhost 入口 → 单文件 server.js
 * better-sqlite3 为原生模块，标记 external（打包时随包分发其 node_modules 目录）。
 * 仓库源码的导入使用 .js 后缀（Workers 习惯），本机直跑需要解析到同名 .ts，用插件桥接。
 */
const here = path.dirname(fileURLToPath(import.meta.url))

const jsToTs = {
  name: 'js-to-ts',
  setup(build) {
    build.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith('.') && !path.isAbsolute(args.path)) return // node_modules 不动
      const dir = args.resolveDir
      for (const cand of [
        args.path.replace(/\.js$/, '.ts'),
        args.path,
        path.join(args.path.replace(/\.js$/, ''), 'index.ts'),
        path.join(args.path.replace(/\.js$/, ''), 'index.js'),
      ]) {
        if (cand && fs.existsSync(path.resolve(dir, cand))) return { path: path.resolve(dir, cand) }
      }
    })
  },
}

await build({
  entryPoints: [path.join(here, 'entry.mjs')],
  outfile: path.join(here, 'dist', 'server.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['better-sqlite3'],
  plugins: [jsToTs],
  minify: false,
  sourcemap: false,
  legalComments: 'none',
})

console.log('已打包 selfhost/dist/server.js')
