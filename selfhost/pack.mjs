import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 组装「免环境」学校服务器整合包（zip）：
 *   ArkClassHub-Server-selfhosted.zip
 *     start.bat / README.txt / config.json（首启生成）
 *     runtime/node.exe                ← 内置 Node 运行时（npmmirror 下载）
 *     server/server.js                ← esbuild 打包产物
 *     server/migrations/*.sql
 *     server/node_modules/better-sqlite3(+deps)
 *     web/dist/**                     ← 前端构建（VITE_API_BASE 为空 = 同源部署）
 *
 * 前置：selfhost/build.mjs 已跑（或本脚本会自动调用）；web 仓库与本仓库同级目录。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const webRoot = path.resolve(repoRoot, '..', 'ArkClassHub-Web-main')

const NODE_VERSION = 'v26.13.1'
const NODE_URL = `https://npmmirror.com/mirrors/node/${NODE_VERSION}/win-x64/node.exe`

async function ensureRuntime() {
  const dir = path.join(repoRoot, 'selfhost', 'runtime')
  const exe = path.join(dir, 'node.exe')
  if (fs.existsSync(exe)) return exe
  fs.mkdirSync(dir, { recursive: true })
  console.log('下载内置 Node 运行时…')
  const res = await fetch(NODE_URL)
  if (!res.ok) throw new Error(`node.exe 下载失败：HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1_000_000) throw new Error('node.exe 下载内容异常')
  fs.writeFileSync(exe, buf)
  return exe
}

/** 递归复制包及其运行时依赖（node_modules） */
function copyModule(name, destNodeModules, seen = new Set()) {
  if (seen.has(name)) return
  seen.add(name)
  const src = path.join(repoRoot, 'node_modules', name)
  if (!fs.existsSync(src)) throw new Error(`缺少依赖 ${name}（先 npm install）`)
  const dest = path.join(destNodeModules, name)
  fs.cpSync(src, dest, { recursive: true })
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'))
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    copyModule(dep, destNodeModules, seen)
  }
}

async function main() {
  // 0) 打包前端（selfhost 模式：VITE_API_BASE 为空 = 同源部署）
  console.log('构建前端（selfhost 模式）…')
  execSync('npx vite build --mode selfhost --outDir selfhost-dist --emptyOutDir', {
    cwd: webRoot,
    stdio: 'inherit',
    shell: true,
  })

  // 1) 打包服务端
  console.log('打包服务端…')
  spawnSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit' })
  const serverJs = path.join(here, 'dist', 'server.js')
  if (!fs.existsSync(serverJs)) throw new Error('server.js 打包失败')

  // 2) 组装整合包目录
  const pkg = path.join(repoRoot, 'selfhost', 'package')
  fs.rmSync(pkg, { recursive: true, force: true })
  fs.mkdirSync(path.join(pkg, 'server'), { recursive: true })

  fs.copyFileSync(serverJs, path.join(pkg, 'server', 'server.js'))
  fs.cpSync(path.join(repoRoot, 'migrations'), path.join(pkg, 'server', 'migrations'), { recursive: true })
  const nm = path.join(pkg, 'server', 'node_modules')
  copyModule('better-sqlite3', nm)

  const exe = await ensureRuntime()
  fs.mkdirSync(path.join(pkg, 'runtime'), { recursive: true })
  fs.copyFileSync(exe, path.join(pkg, 'runtime', 'node.exe'))

  fs.cpSync(path.join(webRoot, 'selfhost-dist'), path.join(pkg, 'web', 'dist'), { recursive: true })

  fs.writeFileSync(
    path.join(pkg, 'start.bat'),
    ['@echo off', 'cd /d %~dp0', 'title ArkClassHub Server', 'runtime\\node.exe server\\server.js', 'pause'].join('\r\n'),
  )
  fs.writeFileSync(
    path.join(pkg, 'README.txt'),
    [
      '方舟班级中心 · 学校服务器自托管版（免环境，解压即用）',
      '==========================================================',
      '',
      '启动：双击 start.bat（内置 Node 运行时，无需安装任何环境）',
      '访问：http://localhost:8080（局域网用 http://<本机IP>:8080）',
      '',
      '首次使用：打开首页 → 用邀请码激活 → 引导码见 config.json',
      '（bootstrapCode 字段，首次启动自动生成；也可手动指定再启动）',
      '',
      '数据：data/ark.db（SQLite 单文件，备份=停止服务后拷走它）',
      '端口：config.json 的 port 字段，改完重启生效',
      '推送：config.json 填 VAPID 公私钥后重启生效（HTTPS 反代下才可用浏览器推送）',
      '',
      '说明：',
      '- 前后端同源部署，本包前端与 Cloudflare 版互相独立、数据不互通',
      '- 纯 HTTP 下浏览器推送与 PWA 安装不可用（浏览器限制），页面功能完整',
      '- 如需开机自启：把 start.bat 的快捷方式放入 shell:startup，或用任务计划程序',
      '- 升级：用新版包覆盖 server/server.js 与 web/dist 即可，数据保留',
    ].join('\r\n'),
  )

  // 3) 压缩
  const zip = path.join(repoRoot, 'selfhost', 'ArkClassHub-Server-selfhosted.zip')
  fs.rmSync(zip, { force: true })
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${pkg}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal"`,
    { stdio: 'inherit' },
  )
  const size = (fs.statSync(zip).size / 1024 / 1024).toFixed(1)
  console.log(`整合包完成：${zip}（${size} MB）`)
}

main().catch((e) => {
  console.error('打包失败:', e.message)
  process.exit(1)
})
