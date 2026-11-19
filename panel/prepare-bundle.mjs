import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 打包前组装 bundle/（electron-builder extraResources 源）：
 *   bundle/runtime/node.exe          ← selfhost/runtime（已有则复用，没有则提示先跑 selfhost/pack.mjs）
 *   bundle/server/{server.js,migrations,node_modules(better-sqlite3)}
 *   bundle/web/dist                  ← 前端 selfhost 模式构建（VITE_API_BASE 为空）
 * 依赖：web 仓库与本仓库同级目录。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const webRoot = path.resolve(repoRoot, '..', 'ArkClassHub-Web-main')

function copyModule(name, destNodeModules, seen = new Set()) {
  if (seen.has(name)) return
  seen.add(name)
  const src = path.join(repoRoot, 'node_modules', name)
  if (!fs.existsSync(src)) throw new Error(`缺少依赖 ${name}（先 npm install）`)
  fs.cpSync(src, path.join(destNodeModules, name), { recursive: true })
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'))
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyModule(dep, destNodeModules, seen)
}

async function main() {
  // 1) 前端（selfhost 模式）
  console.log('构建前端（selfhost 模式）…')
  spawnSync('npx.cmd', ['vite', 'build', '--mode', 'selfhost', '--outDir', 'selfhost-dist', '--emptyOutDir'], {
    cwd: webRoot,
    stdio: 'inherit',
    shell: true,
  })
  if (!fs.existsSync(path.join(webRoot, 'selfhost-dist', 'index.html'))) {
    throw new Error('前端构建失败')
  }

  // 2) 服务端单文件
  console.log('打包服务端…')
  spawnSync(process.execPath, [path.join(repoRoot, 'selfhost', 'build.mjs')], { stdio: 'inherit' })
  const serverJs = path.join(repoRoot, 'selfhost', 'dist', 'server.js')
  if (!fs.existsSync(serverJs)) throw new Error('server.js 打包失败')

  // 3) 组装 bundle/
  //    注意：依赖目录刻意叫 mods 而非 node_modules —— electron-builder 的 extraResources
  //    会吞掉名字为 node_modules 的目录；运行时用 NODE_PATH 指向 mods 解析
  const bundle = path.join(here, 'bundle')
  fs.rmSync(bundle, { recursive: true, force: true })
  fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true })
  fs.mkdirSync(path.join(bundle, 'server'), { recursive: true })

  const nodeExe = path.join(repoRoot, 'selfhost', 'runtime', 'node.exe')
  if (!fs.existsSync(nodeExe)) {
    throw new Error('缺少 selfhost/runtime/node.exe —— 先运行 node selfhost/pack.mjs（或手动放置）')
  }
  fs.copyFileSync(nodeExe, path.join(bundle, 'runtime', 'node.exe'))

  fs.copyFileSync(serverJs, path.join(bundle, 'server', 'server.js'))
  fs.cpSync(path.join(repoRoot, 'migrations'), path.join(bundle, 'server', 'migrations'), { recursive: true })
  const nm = path.join(bundle, 'server', 'mods')
  copyModule('better-sqlite3', nm)

  fs.cpSync(path.join(webRoot, 'selfhost-dist'), path.join(bundle, 'web', 'dist'), { recursive: true })
  console.log('bundle/ 已组装完成')
}

main().catch((e) => {
  console.error('组装失败:', e.message)
  process.exit(1)
})
