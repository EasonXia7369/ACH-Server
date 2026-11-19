const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage } = require('electron')
const { spawn } = require('child_process')
const https = require('https')
const http = require('http')
const net = require('net')
const fs = require('fs')
const path = require('path')
const os = require('os')
const forge = require('node-forge')

/**
 * ArkClassHub 服务面板（Windows 托盘应用）
 * - 宿主业务服务：spawn 内置 node.exe 跑 server/server.js，崩溃自动重启（退避）
 * - 托盘菜单：打开面板 / 启停服务 / 打开班级中心 / 开机自启 / 退出
 * - 管理窗口：状态总览 / 配置 / 日志 / 备份 / HTTPS / 升级
 * - 数据一律放「程序目录/data/」（数据库/日志/备份/证书），备份=拷文件夹
 */

const PANEL_VERSION = app.getVersion()
const singleLock = app.requestSingleInstanceLock()
if (!singleLock) {
  app.quit()
}

/* ---------- 路径布局 ---------- */

let paths
function initPaths() {
  const exeDir = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname)
  paths = {
    exeDir,
    bundle: app.isPackaged ? path.join(resources, 'bundle') : path.join(__dirname, 'bundle'),
    nodeExe: path.join(app.isPackaged ? path.join(resources, 'bundle') : path.join(__dirname, 'bundle'), 'runtime', 'node.exe'),
    serverJs: path.join(app.isPackaged ? path.join(resources, 'bundle') : path.join(__dirname, 'bundle'), 'server', 'server.js'),
    serverDir: path.join(app.isPackaged ? path.join(resources, 'bundle') : path.join(__dirname, 'bundle'), 'server'),
    webRoot: path.join(app.isPackaged ? path.join(resources, 'bundle') : path.join(__dirname, 'bundle'), 'web', 'dist'),
    dataDir: path.join(exeDir, 'data'),
    logsDir: path.join(exeDir, 'data', 'logs'),
    backupsDir: path.join(exeDir, 'data', 'backups'),
    httpsDir: path.join(exeDir, 'data', 'https'),
    upgradeDir: path.join(exeDir, 'data', 'upgrade'),
    configPath: path.join(exeDir, 'data', 'config.json'),
    dbPath: path.join(exeDir, 'data', 'ark.db'),
    exeName: app.isPackaged ? path.basename(app.getPath('exe')) : 'electron.exe',
  }
  for (const d of [paths.dataDir, paths.logsDir, paths.backupsDir]) {
    fs.mkdirSync(d, { recursive: true })
  }
}

/* ---------- 配置 ---------- */

let config = null

function defaultConfig() {
  return {
    schoolName: '',
    port: 8080,
    bootstrapCode: randomCode(8),
    vapidPublicKey: '',
    vapidPrivateKey: '',
    vapidSubject: '',
    httpsEnabled: false,
    httpsPort: 8443,
    wizardDone: false,
  }
}

function loadConfig() {
  try {
    config = { ...defaultConfig(), ...JSON.parse(fs.readFileSync(paths.configPath, 'utf8')) }
  } catch {
    config = defaultConfig()
  }
  return config
}

function saveConfig(patch = {}) {
  config = { ...config, ...patch }
  fs.mkdirSync(paths.dataDir, { recursive: true })
  fs.writeFileSync(paths.configPath, JSON.stringify(config, null, 2))
  return config
}

function randomCode(len) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = require('crypto').randomBytes(len)
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return out
}

/* ---------- 日志 ---------- */

let logTail = []
const LOG_TAIL_MAX = 600

function appendLog(line, fromService) {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const full = `[${ts}] ${line}`
  logTail.push(full)
  if (logTail.length > LOG_TAIL_MAX) logTail.splice(0, logTail.length - LOG_TAIL_MAX)
  try {
    const day = new Date().toISOString().slice(0, 10)
    fs.appendFileSync(path.join(paths.logsDir, `server-${day}.log`), full + '\n')
  } catch {
    /* 日志失败不影响运行 */
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('panel:log', full)
  }
}

/* ---------- 服务宿主 ---------- */

let serviceChild = null
let serviceState = 'stopped' // running | starting | stopping | stopped | crashed
let serviceStartedAt = null
let manualStop = false
let crashCount = 0
let crashTimer = null
let restartTimer = null

function servicePort() {
  return Number(config?.port) || 8080
}

function startService() {
  if (serviceChild || serviceState === 'running' || serviceState === 'starting') return
  manualStop = false
  serviceState = 'starting'
  appendLog(`正在启动班级服务（端口 ${servicePort()}）…`)
  try {
    serviceChild = spawn(paths.nodeExe, [paths.serverJs], {
      cwd: paths.serverDir,
      env: {
        ...process.env,
        ARK_CONFIG_FILE: paths.configPath,
        ARK_DATA_DIR: paths.dataDir,
        ARK_WEB_ROOT: paths.webRoot,
        // 服务依赖目录刻意不叫 node_modules（electron-builder extraResources 会吞该名字的目录），
        // 用 NODE_PATH 让打包产物内的 require 解析到 bundle/server/mods
        NODE_PATH: path.join(paths.serverDir, 'mods'),
      },
      windowsHide: true,
    })
  } catch (e) {
    serviceChild = null
    serviceState = 'crashed'
    appendLog(`服务启动失败：${e.message}`)
    return
  }
  serviceChild.stdout.on('data', (d) => {
    for (const line of String(d).split('\n')) if (line.trim()) appendLog(line.trim(), true)
  })
  serviceChild.stderr.on('data', (d) => {
    for (const line of String(d).split('\n')) if (line.trim()) appendLog('[err] ' + line.trim(), true)
  })
  serviceChild.on('exit', (code) => {
    serviceChild = null
    const wasRunning = serviceState === 'running'
    serviceState = manualStop ? 'stopped' : 'crashed'
    if (manualStop) {
      appendLog('班级服务已停止')
      return
    }
    if (wasRunning) crashCount++
    appendLog(`班级服务异常退出（code=${code}），已${crashCount >= 5 ? '暂停' : '安排'}自动重启`)
    if (crashCount < 5) {
      restartTimer = setTimeout(startService, Math.min(3000 * crashCount, 15000))
    } else {
      // 连续崩溃 5 次：停止重试，等待人工处理（面板可手动启动重置计数）
      appendLog('连续崩溃 5 次，自动重启已暂停。请查看日志排查后手动启动。')
    }
  })
  // 启动成功探测：端口可连即视为 running
  const probe = setInterval(() => {
    if (!serviceChild) {
      clearInterval(probe)
      return
    }
    probePort(servicePort()).then((ok) => {
      if (ok) {
        clearInterval(probe)
        serviceState = 'running'
        serviceStartedAt = Date.now()
        crashCount = 0
        appendLog('班级服务已就绪')
        notifyTray()
      }
    })
  }, 600)
  // 30 秒仍未就绪不判死：端口探测循环在 child 存活期间持续
}

function probePort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 1200 })
    s.on('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.on('timeout', () => {
      s.destroy()
      resolve(false)
    })
    s.on('error', () => resolve(false))
  })
}

function stopService(cb) {
  manualStop = true
  if (restartTimer) clearTimeout(restartTimer)
  if (!serviceChild) {
    serviceState = 'stopped'
    cb && cb()
    return
  }
  serviceState = 'stopping'
  try {
    // Windows：终止进程树
    spawn('taskkill', ['/PID', String(serviceChild.pid), '/T', '/F'], { windowsHide: true })
  } catch {
    try {
      serviceChild.kill()
    } catch {
      /* ignore */
    }
  }
  const waitStop = setInterval(() => {
    if (!serviceChild) {
      clearInterval(waitStop)
      serviceState = 'stopped'
      appendLog('班级服务已停止')
      cb && cb()
    }
  }, 200)
  setTimeout(() => {
    clearInterval(waitStop)
    if (serviceChild) {
      try {
        serviceChild.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    serviceState = 'stopped'
    cb && cb()
  }, 8000)
}

function restartService() {
  stopService(() => startService())
}

/* ---------- 备份 ---------- */

const BACKUP_KEEP = 14

function backupScript(action, src, dest) {
  // 通过内置 node.exe 执行（better-sqlite3 在 bundle/server/node_modules）
  const code =
    action === 'backup'
      ? `const Database=require('better-sqlite3');const db=new Database(process.argv[1],{readonly:true});db.backup(process.argv[2]).then(()=>{db.close();console.log('ok')}).catch(e=>{console.error(e.message);process.exit(1)})`
      : `const fs=require('fs');for(const s of [process.argv[2]+'-wal',process.argv[2]+'-shm']){try{fs.unlinkSync(s)}catch{}}fs.copyFileSync(process.argv[1],process.argv[2]);console.log('ok')`
  return new Promise((resolve, reject) => {
    const p = spawn(paths.nodeExe, ['-e', code, src, dest], {
      cwd: paths.serverDir,
      env: {
        ...process.env,
        // 依赖在 bundle/server/mods（面板打包布局），NODE_PATH 解析
        NODE_PATH: path.join(paths.serverDir, 'mods'),
      },
      windowsHide: true,
    })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(out.trim() || `退出码 ${code}`))))
  })
}

function backupFile() {
  return path.join(paths.backupsDir, `ark-${new Date().toISOString().slice(0, 10)}.bak`)
}

async function backupNow(reason = '手动') {
  fs.mkdirSync(paths.backupsDir, { recursive: true })
  const dest = backupFile()
  await backupScript('backup', paths.dbPath, dest)
  pruneBackups()
  appendLog(`数据库已备份（${reason}）：${path.basename(dest)}`)
  return path.basename(dest)
}

function pruneBackups() {
  try {
    const files = fs
      .readdirSync(paths.backupsDir)
      .filter((f) => /^ark-\d{4}-\d{2}-\d{2}\.bak$/.test(f))
      .sort()
    while (files.length > BACKUP_KEEP) {
      fs.unlinkSync(path.join(paths.backupsDir, files.shift()))
    }
  } catch {
    /* 清理失败不影响 */
  }
}

function scheduleDailyBackup() {
  setInterval(async () => {
    try {
      if (!fs.existsSync(paths.dbPath)) return
      if (fs.existsSync(backupFile())) return
      await backupNow('每日自动')
    } catch (e) {
      appendLog(`自动备份失败：${e.message}`)
    }
  }, 30 * 60 * 1000) // 每 30 分钟检查一次当天是否已备份
}

/* ---------- HTTPS（自签证书 + 反向代理，含 WebSocket） ---------- */

let httpsServer = null

function localIPs() {
  const out = []
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const i of ifs ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address)
    }
  }
  return out
}

function ensureCert() {
  fs.mkdirSync(paths.httpsDir, { recursive: true })
  const keyP = path.join(paths.httpsDir, 'key.pem')
  const certP = path.join(paths.httpsDir, 'cert.pem')
  if (fs.existsSync(keyP) && fs.existsSync(certP)) {
    return { key: fs.readFileSync(keyP, 'utf8'), cert: fs.readFileSync(certP, 'utf8') }
  }
  appendLog('正在生成自签证书…')
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01' + Date.now().toString(16)
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400_000)
  const attrs = [
    { name: 'commonName', value: 'ArkClassHub' },
    { name: 'organizationName', value: 'ArkClassHub Server Panel' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  const sans = ['localhost', '127.0.0.1', ...localIPs()]
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true },
    {
      name: 'subjectAltName',
      altNames: sans.map((ip) => (net.isIP(ip) ? { type: 7, ip } : { type: 2, value: ip })),
    },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey)
  const certPem = forge.pki.certificateToPem(cert)
  fs.writeFileSync(keyP, keyPem)
  fs.writeFileSync(certP, certPem)
  // 导出 .crt 供 Windows 信任安装
  fs.writeFileSync(path.join(paths.httpsDir, 'ArkClassHub.crt'), certPem)
  appendLog('自签证书已生成（10 年有效）')
  return { key: keyPem, cert: certPem }
}

function startHttpsProxy() {
  stopHttpsProxy()
  if (!config.httpsEnabled) return
  try {
    const { key, cert } = ensureCert()
    const targetPort = servicePort()
    httpsServer = https.createServer({ key, cert }, (cliReq, cliRes) => {
      const px = http.request(
        { host: '127.0.0.1', port: targetPort, path: cliReq.url, method: cliReq.method, headers: cliReq.headers },
        (pRes) => {
          cliRes.writeHead(pRes.statusCode, pRes.headers)
          pRes.pipe(cliRes)
        },
      )
      px.on('error', () => {
        cliRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
        cliRes.end('班级服务未运行')
      })
      cliReq.pipe(px)
    })
    // WebSocket：原始 TCP 透传（协议无关，最稳）
    httpsServer.on('upgrade', (cliReq, cliSock, head) => {
      const target = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
        const raw = `${cliReq.method} ${cliReq.url} HTTP/1.1\r\n${cliReq.rawHeaders
          .reduce((acc, _v, i, arr) => {
            if (i % 2 === 0) acc.push(`${arr[i]}: ${arr[i + 1]}`)
            return acc
          }, [])
          .join('\r\n')}\r\n\r\n`
        target.write(raw)
        if (head?.length) target.write(head)
        cliSock.pipe(target).pipe(cliSock)
      })
      target.on('error', () => cliSock.destroy())
      cliSock.on('error', () => target.destroy())
    })
    httpsServer.listen(config.httpsPort || 8443, () => {
      appendLog(`HTTPS 反代已启动（:${config.httpsPort || 8443} → :${targetPort}）`)
      notifyTray()
    })
    httpsServer.on('error', (e) => {
      appendLog(`HTTPS 启动失败：${e.message}（端口被占用？）`)
      httpsServer = null
    })
  } catch (e) {
    appendLog(`HTTPS 初始化失败：${e.message}`)
  }
}

function stopHttpsProxy() {
  if (httpsServer) {
    try {
      httpsServer.close()
    } catch {
      /* ignore */
    }
    httpsServer = null
  }
}

/* ---------- 升级 ---------- */

const GITHUB_REPO = 'EasonXia7369/ArkClassHub-Desktop'

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'ArkClassHub-Panel' } }, (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (e) {
            reject(new Error('响应解析失败'))
          }
        })
      })
      .on('error', reject)
  })
}

function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    https
      .get(url, { headers: { 'User-Agent': 'ArkClassHub-Panel' } }, (res) => {
        if (res.statusCode !== 200) {
          file.close()
          fs.unlinkSync(dest)
          return reject(new Error(`下载失败 HTTP ${res.statusCode}`))
        }
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve(dest)))
      })
      .on('error', (e) => {
        try {
          fs.unlinkSync(dest)
        } catch {
          /* ignore */
        }
        reject(e)
      })
  })
}

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1
  }
  return 0
}

async function checkUpdate() {
  const rel = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`)
  if (!Array.isArray(rel)) throw new Error('无法获取版本信息（网络不可达？）')
  const panelRel = rel.find((r) => (r.tag_name || '').startsWith('panel-v') && !r.draft)
  if (!panelRel) return { updateAvailable: false, current: PANEL_VERSION, latest: null, notes: '' }
  const latest = panelRel.tag_name.replace('panel-v', '')
  const asset = (panelRel.assets || []).find((a) => a.name.endsWith('-win.zip') && a.name.includes('Panel'))
  return {
    updateAvailable: cmpVersion(latest, PANEL_VERSION) > 0,
    current: PANEL_VERSION,
    latest,
    notes: panelRel.body || '',
    downloadUrl: asset?.browser_download_url || null,
    assetName: asset?.name || null,
  }
}

async function applyUpdate(progress) {
  const info = await checkUpdate()
  if (!info.updateAvailable || !info.downloadUrl) throw new Error('没有可用的更新包')
  fs.mkdirSync(paths.upgradeDir, { recursive: true })
  const zipPath = path.join(paths.upgradeDir, info.assetName || 'panel-update.zip')
  progress?.('下载更新包…')
  await downloadTo(info.downloadUrl, zipPath)
  progress?.('解压更新包…')
  const staging = path.join(paths.upgradeDir, 'staging')
  fs.rmSync(staging, { recursive: true, force: true })
  await new Promise((resolve, reject) => {
    const p = spawn(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${staging}' -Force`],
      { windowsHide: true },
    )
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('解压失败'))))
  })
  // zip 根可能包一层目录，找到含 exe 的层级
  let installSrc = staging
  const entries = fs.readdirSync(staging)
  if (entries.length === 1 && fs.statSync(path.join(staging, entries[0])).isDirectory()) {
    installSrc = path.join(staging, entries[0])
  }
  if (!fs.existsSync(path.join(installSrc, paths.exeName))) {
    throw new Error('更新包内未找到面板程序')
  }
  progress?.('准备替换脚本…')
  writeUpgradeBat(installSrc)
  return info.latest
}

function writeUpgradeBat(installSrc) {
  const bat = path.join(paths.upgradeDir, 'upgrade.bat')
  const exePath = app.isPackaged ? app.getPath('exe') : process.execPath
  const content = [
    '@echo off',
    'chcp 65001 >nul',
    'echo 等待面板退出…',
    'timeout /t 2 /nobreak >nul',
    `taskkill /F /IM "${paths.exeName}" >nul 2>&1`,
    'timeout /t 2 /nobreak >nul',
    `robocopy "${installSrc}" "${paths.exeDir}" /E /NFL /NDL /NJH /NJS >nul`,
    `start "" "${exePath}"`,
    `rd /s /q "${paths.upgradeDir}"`,
    'exit',
  ].join('\r\n')
  fs.writeFileSync(bat, content)
}

function launchUpgradeBat() {
  const bat = path.join(paths.upgradeDir, 'upgrade.bat')
  if (!fs.existsSync(bat)) return
  spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

/* ---------- 托盘与窗口 ---------- */

let tray = null
let win = null

function trayIcon() {
  const ico = path.join(__dirname, 'build', 'icon.ico')
  if (fs.existsSync(ico)) return nativeImage.createFromPath(ico)
  return nativeImage.createEmpty()
}

function createTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip('ArkClassHub 服务面板')
  tray.on('double-click', () => showWindow())
  rebuildTrayMenu()
}

function rebuildTrayMenu() {
  const stateLabel =
    serviceState === 'running'
      ? `运行中（:${servicePort()}${config.httpsEnabled ? ` / HTTPS :${config.httpsPort || 8443}` : ''}）`
      : serviceState === 'crashed'
        ? '异常停止（可手动启动）'
        : serviceState === 'starting'
          ? '启动中…'
          : '已停止'
  const menu = Menu.buildFromTemplate([
    { label: `服务状态：${stateLabel}`, enabled: false },
    { type: 'separator' },
    { label: '打开面板', click: () => showWindow() },
    serviceState === 'running'
      ? { label: '停止服务', click: () => stopService() }
      : { label: '启动服务', click: () => ((crashCount = 0), startService()) },
    { label: '重启服务', click: () => restartService() },
    { label: '打开班级中心', click: () => openWeb() },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => setAutostart(item.checked),
    },
    { type: 'separator' },
    {
      label: '退出（将停止班级服务）',
      click: () => {
        quitRequested()
      },
    },
  ])
  tray?.setContextMenu(menu)
}

function notifyTray() {
  rebuildTrayMenu()
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }
  win = new BrowserWindow({
    width: 920,
    height: 660,
    minWidth: 820,
    minHeight: 560,
    title: 'ArkClassHub 服务面板',
    autoHideMenuBar: true,
    icon: trayIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  win.loadFile(path.join(__dirname, 'ui', 'index.html'))
  win.on('close', (e) => {
    // 点关闭=隐藏到托盘（服务继续跑）；真退出走托盘菜单
    if (!(app.quitting || global.forceQuit)) {
      e.preventDefault()
      win.hide()
    }
  })
}

function openWeb() {
  const proto = config.httpsEnabled ? 'https' : 'http'
  const port = config.httpsEnabled ? config.httpsPort || 8443 : servicePort()
  shell.openExternal(`${proto}://localhost:${port}`)
}

function setAutostart(on) {
  app.setLoginItemSettings({ openAtLogin: !!on, path: app.getPath('exe') })
  return app.getLoginItemSettings().openAtLogin
}

let quitConfirmed = false
function quitRequested() {
  dialog
    .showMessageBox({
      type: 'question',
      buttons: ['停止服务并退出', '取消'],
      defaultId: 0,
      cancelId: 1,
      message: '退出服务面板？',
      detail: '退出后班级中心将无法访问，直到再次启动面板。',
    })
    .then(({ response }) => {
      if (response === 0) {
        quitConfirmed = true
        stopService(() => {
          app.exit(0)
        })
        setTimeout(() => app.exit(0), 9000) // 兜底
      }
    })
}

/* ---------- IPC ---------- */

function snapshot() {
  let dbSizeMB = 0
  try {
    dbSizeMB = +((fs.statSync(paths.dbPath).size || 0) / 1024 / 1024).toFixed(1)
  } catch {
    /* 无数据库 */
  }
  const backups = fs.existsSync(paths.backupsDir)
    ? fs.readdirSync(paths.backupsDir).filter((f) => f.endsWith('.bak'))
    : []
  const httpsActive = !!httpsServer && config.httpsEnabled
  return {
    version: PANEL_VERSION,
    wizardNeeded: !config.wizardDone,
    schoolName: config.schoolName || '',
    serviceState,
    port: servicePort(),
    uptimeSec: serviceState === 'running' && serviceStartedAt ? Math.floor((Date.now() - serviceStartedAt) / 1000) : 0,
    https: { enabled: !!config.httpsEnabled, active: httpsActive, port: config.httpsPort || 8443 },
    dbSizeMB,
    backupCount: backups.length,
    latestBackup: backups.sort().slice(-1)[0] || null,
    autostart: app.getLoginItemSettings().openAtLogin,
    onlineHint: `http://localhost:${servicePort()}`,
    httpsHint: `https://localhost:${config.httpsPort || 8443}`,
    dataDir: paths.dataDir,
    exeDir: paths.exeDir,
  }
}

function registerIpc() {
  ipcMain.handle('panel:state', () => snapshot())
  ipcMain.handle('panel:logs', () => logTail.slice(-200))
  ipcMain.handle('panel:get-config', () => loadConfig())
  ipcMain.handle('panel:save-config', (_e, patch) => {
    const prevPort = servicePort()
    const prevHttps = !!config.httpsEnabled
    saveConfig(patch)
    // 端口/HTTPS 变更 → 热应用
    if (Number(patch.port) && Number(patch.port) !== prevPort && serviceState === 'running') {
      restartService()
    }
    if (!!patch.httpsEnabled !== prevHttps || (patch.httpsEnabled && Number(patch.httpsPort) !== config.httpsPort)) {
      config.httpsEnabled ? startHttpsProxy() : stopHttpsProxy()
    }
    return snapshot()
  })
  ipcMain.handle('panel:check-port', async (_e, port) => {
    const p = Number(port) || 8080
    const inUseBySelf = p === servicePort() && serviceState === 'running'
    const free = await new Promise((resolve) => {
      const test = net.createServer()
      test.once('error', () => resolve(false))
      test.once('listening', () => test.close(() => resolve(true)))
      test.listen(p, '0.0.0.0')
    })
    return { ok: free || inUseBySelf, free, inUseBySelf }
  })
  ipcMain.handle('panel:start-service', () => {
    crashCount = 0
    startService()
    return true
  })
  ipcMain.handle('panel:stop-service', () => {
    stopService()
    return true
  })
  ipcMain.handle('panel:restart-service', () => {
    restartService()
    return true
  })
  ipcMain.handle('panel:open-web', () => {
    openWeb()
    return true
  })
  ipcMain.handle('panel:open-folder', (_e, which) => {
    shell.openPath(which === 'data' ? paths.dataDir : paths.exeDir)
    return true
  })
  ipcMain.handle('panel:backup-now', async () => {
    const name = await backupNow()
    return { name, ...snapshot() }
  })
  ipcMain.handle('panel:list-backups', () => {
    try {
      return fs
        .readdirSync(paths.backupsDir)
        .filter((f) => f.endsWith('.bak'))
        .map((f) => {
          const st = fs.statSync(path.join(paths.backupsDir, f))
          return { name: f, sizeMB: +(st.size / 1024 / 1024).toFixed(2), date: st.mtime.toISOString() }
        })
        .sort((a, b) => b.name.localeCompare(a.name))
    } catch {
      return []
    }
  })
  ipcMain.handle('panel:restore-backup', async (_e, name) => {
    if (!/^ark-\d{4}-\d{2}-\d{2}\.bak$/.test(name)) throw new Error('非法备份文件名')
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['停止服务并恢复', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: `用 ${name} 覆盖当前数据库？`,
      detail: '恢复会先停止班级服务；备份之后录入的数据将被覆盖，不可撤销。',
    })
    if (response !== 0) return { canceled: true }
    await new Promise((resolve) => stopService(resolve))
    await backupScript('restore', path.join(paths.backupsDir, name), paths.dbPath)
    appendLog(`数据库已从 ${name} 恢复`)
    startService()
    return { restored: true }
  })
  ipcMain.handle('panel:check-update', async () => checkUpdate())
  ipcMain.handle('panel:apply-update', async (_e, onProgress) => {
    return applyUpdate((s) => win?.webContents?.send('panel:upgrade-progress', s))
  })
  ipcMain.handle('panel:reboot-into-update', () => {
    launchUpgradeBat()
    app.exit(0)
  })
  ipcMain.handle('panel:set-autostart', (_e, on) => setAutostart(on))
  ipcMain.handle('panel:open-cert-folder', () => {
    shell.openPath(paths.httpsDir)
    return true
  })
  ipcMain.handle('panel:finish-wizard', (_e, cfg) => {
    saveConfig({ ...cfg, wizardDone: true })
    stopHttpsProxy()
    startHttpsProxy()
    if (serviceState === 'running') restartService()
    else startService()
    return snapshot()
  })
}

/* ---------- 生命周期 ---------- */

app.on('second-instance', () => showWindow())

app.whenReady().then(() => {
  if (!singleLock) return
  initPaths()
  // 先读再落盘：保证 saveConfig 时 config 已有默认值；首次启动立即写面板版 config（先于业务服务）
  loadConfig()
  if (!fs.existsSync(paths.configPath)) saveConfig()
  registerIpc()
  createTray()
  showWindow()
  startService()
  startHttpsProxy()
  scheduleDailyBackup()
  appendLog(`服务面板已启动 v${PANEL_VERSION}`)
})

app.on('before-quit', () => {
  app.quitting = true
})
app.on('window-all-closed', () => {
  // 关闭窗口=隐藏到托盘；退出走托盘菜单（quitRequested）
})
process.on('exit', () => {
  try {
    serviceChild?.kill()
  } catch {
    /* ignore */
  }
})
