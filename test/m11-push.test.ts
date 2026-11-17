import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { createD1Shim } from './helpers.js'
import { createApp } from '../src/index.js'
import { pushClass, pushEnabled, type PushPayload } from '../src/push.js'

/**
 * Web Push 测试：本地 HTTP 服务模拟推送网关 + Node WebCrypto 模拟浏览器订阅侧，
 * 端到端验证 VAPID JWT 签名、RFC 8291 aes128gcm 加密往返与订阅扇出规则。
 */

/* ---------- 测试环境（带 VAPID 密钥） ---------- */

const VAPID_PUBLIC_KEY = 'BH6WJj-M-_faQv9GgNpgNLP-Ak1gZNnve8jYrvnWGtPekTJ9H0f7hEScgfH02xO-5HpYrh7X-MsQV3NZpA9dd-Q'
const VAPID_PRIVATE_KEY = '98_KY0wfglRAnf6BzJaUU4xvtR1G5bLv4lsdir3_weg'

function b64uToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(norm + '='.repeat((4 - (norm.length % 4)) % 4)), (ch) => ch.charCodeAt(0))
}

function bytesToB64u(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url')
}

function createCtx() {
  const db = new Database(':memory:')
  for (const f of readdirSync(new URL('../migrations', import.meta.url)).sort()) {
    if (f.endsWith('.sql')) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'))
  }
  const env = {
    DB: createD1Shim(db),
    ARK_BOOTSTRAP_CODE: 'TESTBOOT',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY,
  }
  const app = createApp()
  const pendingWait: Promise<unknown>[] = []
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      pendingWait.push(p)
    },
    passThroughOnException: () => {},
  }
  const inject = async (opts: {
    method: string
    url: string
    payload?: any
    headers?: Record<string, string>
  }): Promise<{ statusCode: number; json: () => any }> => {
    const init: RequestInit = { method: opts.method, headers: opts.headers }
    if (opts.payload !== undefined) {
      init.body = JSON.stringify(opts.payload)
      init.headers = { ...opts.headers, 'Content-Type': 'application/json' }
    }
    const res = await app.request(opts.url, init, env as any, executionCtx as any)
    await Promise.allSettled(pendingWait.splice(0))
    const data = await res.json().catch(() => ({}))
    return { statusCode: res.status, json: () => data }
  }
  /** 直接查内存库（better-sqlite3 同步接口） */
  const query = (sql: string): any[] => db.prepare(sql).all() as any[]
  return { inject, env, query }
}

/* ---------- 捕获型推送网关 ---------- */

interface CapturedRequest {
  path: string
  authorization: string | undefined
  contentType: string | string[] | undefined
  contentEncoding: string | string[] | undefined
  ttl: string | string[] | undefined
  body: Buffer
  statusCode: number
}

function startGateway(): Promise<{ port: number; captured: CapturedRequest[]; close: () => Promise<void> }> {
  const captured: CapturedRequest[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      // /dead 返回 410（模拟浏览器侧订阅失效），其余 201
      const statusCode = req.url === '/dead' ? 410 : 201
      captured.push({
        path: req.url ?? '',
        authorization: req.headers.authorization as unknown as string | undefined,
        contentType: req.headers['content-type'],
        contentEncoding: req.headers['content-encoding'],
        ttl: req.headers.ttl,
        body: Buffer.concat(chunks),
        statusCode,
      })
      res.writeHead(statusCode)
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        port: addr.port,
        captured,
        close: () => new Promise<void>((ok) => server.close(() => ok())),
      })
    })
  })
}

/* ---------- 浏览器侧订阅密钥（模拟 UA） ---------- */

async function makeUaKeys() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair
  const pubBytes = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey as any)) as ArrayBuffer,
  )
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return {
    pubBytes,
    privateKey: pair.privateKey,
    auth,
    p256dh: bytesToB64u(pubBytes),
    authB64: bytesToB64u(auth),
  }
}

/* ---------- UA 侧解密（按 RFC 8291，验证服务端加密正确性） ---------- */

async function uaHkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8),
  )
}

async function decryptAes128gcm(
  ua: Awaited<ReturnType<typeof makeUaKeys>>,
  received: Buffer,
): Promise<Uint8Array> {
  const rs = received.readUInt32BE(0)
  const salt = received.subarray(4, 20)
  const idlen = received[20]
  const asPublic = received.subarray(21, 21 + idlen)
  const cipher = received.subarray(21 + idlen)

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'ECDH',
        public: await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []),
      } as any,
      ua.privateKey,
      256,
    ),
  )
  const ikm = await uaHkdf(
    shared,
    ua.auth,
    Buffer.concat([Buffer.from('WebPush: info'), Buffer.alloc(1), Buffer.from(ua.pubBytes), Buffer.from(asPublic)]),
    32,
  )
  const cek = await uaHkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await uaHkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)

  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']),
      cipher,
    ),
  )
  // 末尾填充区以 0x02 分隔符结尾（单记录 + 零填充）
  let end = plain.length - 1
  while (end >= 0 && plain[end] === 0) end--
  expect(plain[end]).toBe(0x02)
  expect(end).toBeLessThan(rs - 16) // 载荷不超单记录上限
  return plain.subarray(0, end)
}

async function verifyVapidJwt(
  authorization: string | undefined,
  expectedAud: string,
): Promise<void> {
  expect(authorization).toMatch(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=[\w-]+$/)
  const m = authorization!.match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/)!
  expect(m[2]).toBe(VAPID_PUBLIC_KEY)
  const [h, p, sig] = m[1].split('.')
  const header = JSON.parse(Buffer.from(h, 'base64url').toString())
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString())
  expect(header).toEqual({ typ: 'JWT', alg: 'ES256' })
  expect(payload.aud).toBe(expectedAud)
  expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  expect(String(payload.sub)).toMatch(/^mailto:/)
  const key = await crypto.subtle.importKey(
    'raw',
    b64uToBytes(VAPID_PUBLIC_KEY),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    b64uToBytes(sig),
    new TextEncoder().encode(`${h}.${p}`),
  )
  expect(ok).toBe(true)
}

/* ---------- 用例 ---------- */

describe('Web Push', () => {
  let inject: ReturnType<typeof createCtx>['inject']
  let env: ReturnType<typeof createCtx>['env']
  let query: ReturnType<typeof createCtx>['query']
  let gw: Awaited<ReturnType<typeof startGateway>>
  const ep = (path: string) => `http://127.0.0.1:${gw.port}${path}`

  let adminToken: string
  let t1Token: string
  let stuToken: string
  let classId: number

  const uaOf: Record<string, Awaited<ReturnType<typeof makeUaKeys>>> = {}

  it('准备：账号/班级/订阅', async () => {
    const ctx = createCtx()
    inject = ctx.inject
    env = ctx.env
    query = ctx.query
    gw = await startGateway()

    adminToken = (
      await inject({
        method: 'POST',
        url: '/api/auth/activate',
        payload: { code: 'TESTBOOT', name: '管理员', password: 'admin123' },
      })
    ).json().token
    const inv = (
      await inject({
        method: 'POST',
        url: '/api/admin/invites',
        payload: { role: 'teacher' },
        headers: { authorization: `Bearer ${adminToken}` },
      })
    ).json().code
    t1Token = (
      await inject({
        method: 'POST',
        url: '/api/auth/activate',
        payload: { code: inv, name: '张老师', password: 'teach123' },
      })
    ).json().token
    classId = (
      await inject({
        method: 'POST',
        url: '/api/classes',
        payload: { name: '高二6班' },
        headers: { authorization: `Bearer ${t1Token}` },
      })
    ).json().class.id
    await inject({
      method: 'POST',
      url: `/api/classes/${classId}/students`,
      payload: { name: '陈一' },
      headers: { authorization: `Bearer ${t1Token}` },
    })
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/student-pass`,
      payload: { password: '1234' },
      headers: { authorization: `Bearer ${t1Token}` },
    })
    stuToken = (
      await inject({
        method: 'POST',
        url: `/api/classes/${classId}/kiosk-login`,
        payload: { password: '1234' },
      })
    ).json().token

    // 四台"设备"：T1 本机 / 学生机 / 管理员机 / 死订阅机
    for (const [name, token] of [
      ['t1', t1Token],
      ['s', stuToken],
      ['a', adminToken],
      ['dead', t1Token],
    ] as const) {
      uaOf[name] = await makeUaKeys()
      const res = await inject({
        method: 'POST',
        url: '/api/push/subscribe',
        payload: {
          endpoint: ep(`/${name}`),
          keys: { p256dh: uaOf[name].p256dh, auth: uaOf[name].authB64 },
          device_id: `dev-${name}`,
        },
        headers: { authorization: `Bearer ${token}` },
      })
      expect(res.statusCode).toBe(200)
    }
  })

  it('config 返回公钥', async () => {
    const res = await inject({
      method: 'GET',
      url: '/api/push/config',
      headers: { authorization: `Bearer ${t1Token}` },
    })
    expect(res.json()).toEqual({ enabled: true, publicKey: VAPID_PUBLIC_KEY })
  })

  it('重复订阅同一 endpoint 走 UPSERT 不产生重复行', async () => {
    await inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: {
        endpoint: ep('/t1'),
        keys: { p256dh: uaOf.t1.p256dh, auth: uaOf.t1.authB64 },
        device_id: 'dev-t1-new',
      },
      headers: { authorization: `Bearer ${t1Token}` },
    })
    const rows = query('SELECT * FROM push_subscriptions')
    const t1Rows = rows.filter((r) => r.endpoint === ep('/t1'))
    expect(t1Rows).toHaveLength(1)
    expect(t1Rows[0].device_id).toBe('dev-t1-new')
    expect(rows).toHaveLength(4)
  })

  it('扇出：学生/管理员收到，发送者设备排除，JWT 与载荷可验证解密', async () => {
    // 发送者设备 id 换回 dev-t1（上一条用例改成了 dev-t1-new，恢复后它会被排除）
    await inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: {
        endpoint: ep('/t1'),
        keys: { p256dh: uaOf.t1.p256dh, auth: uaOf.t1.authB64 },
        device_id: 'dev-t1',
      },
      headers: { authorization: `Bearer ${t1Token}` },
    })

    await pushClass(env, classId, {
      type: 'message',
      title: '老师来消息了',
      body: '同学们注意：明天带实验报告',
    }, 'dev-t1')

    // /t1 被排除；/s /a 收到；/dead 收到但返回 410
    expect(gw.captured.map((r) => r.path).sort()).toEqual(['/a', '/dead', '/s'])
    for (const r of gw.captured) {
      expect(r.statusCode).toBe(r.path === '/dead' ? 410 : 201)
      expect(r.ttl).toBe('86400')
      expect(r.contentEncoding).toBe('aes128gcm')
      await verifyVapidJwt(r.authorization, `http://127.0.0.1:${gw.port}`)
      const ua = uaOf[r.path.slice(1)]
      const plain = Buffer.from(await decryptAes128gcm(ua, r.body)).toString('utf8')
      const payload: PushPayload = JSON.parse(plain)
      expect(payload).toEqual({
        type: 'message',
        title: '老师来消息了',
        body: '同学们注意：明天带实验报告',
        classId,
        url: '/messages',
      })
    }

    // 死订阅已被清理
    const dead = query('SELECT * FROM push_subscriptions').filter(
      (r) => r.endpoint === ep('/dead'),
    )
    expect(dead).toHaveLength(0)
  })

  it('消息发送经 waitUntil 触发推送（X-Push-Device 排除发送者）', async () => {
    gw.captured.length = 0
    const res = await inject({
      method: 'POST',
      url: `/api/classes/${classId}/messages`,
      payload: { body: '值日生上报：一切正常' },
      headers: { authorization: `Bearer ${t1Token}`, 'X-Push-Device': 'dev-t1' },
    })
    expect(res.statusCode).toBe(200)
    // T1 自身排除 → /s /a 收到
    expect(gw.captured.map((r) => r.path).sort()).toEqual(['/a', '/s'])
    const plain = Buffer.from(
      await decryptAes128gcm(uaOf.s, gw.captured.find((r) => r.path === '/s')!.body),
    ).toString('utf8')
    expect(JSON.parse(plain).body).toBe('值日生上报：一切正常')
  })

  it('考勤异常登记触发推送；纯出勤不推送', async () => {
    const stus = (
      await inject({
        method: 'GET',
        url: `/api/classes/${classId}`,
        headers: { authorization: `Bearer ${t1Token}` },
      })
    ).json().students as Array<{ id: number }>
    const day = '2026-11-17'

    gw.captured.length = 0
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day,
        entries: [{ student_id: stus[0].id, slot: 'morning', status: 'late' }],
      },
      headers: { authorization: `Bearer ${t1Token}`, 'X-Push-Device': 'dev-t1' },
    })
    expect(gw.captured.map((r) => r.path).sort()).toEqual(['/a', '/s'])
    const plain = JSON.parse(
      Buffer.from(await decryptAes128gcm(uaOf.s, gw.captured[0].body)).toString('utf8'),
    )
    expect(plain.type).toBe('attendance')
    expect(plain.title).toBe('考勤更新')
    expect(plain.body).toContain('迟到×1')

    // 纯出勤（清格）不推送
    gw.captured.length = 0
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/attendance`,
      payload: {
        day,
        entries: [{ student_id: stus[0].id, slot: 'noon', status: 'present' }],
      },
      headers: { authorization: `Bearer ${t1Token}`, 'X-Push-Device': 'dev-t1' },
    })
    expect(gw.captured).toHaveLength(0)
  })

  it('布置作业触发推送', async () => {
    gw.captured.length = 0
    await inject({
      method: 'PUT',
      url: `/api/classes/${classId}/hw-tasks`,
      payload: { day: '2026-11-17', subject: '数学', content: '《练习册》P32 第1-8题' },
      headers: { authorization: `Bearer ${t1Token}`, 'X-Push-Device': 'dev-t1' },
    })
    expect(gw.captured.map((r) => r.path).sort()).toEqual(['/a', '/s'])
    const plain = JSON.parse(
      Buffer.from(await decryptAes128gcm(uaOf.s, gw.captured[0].body)).toString('utf8'),
    )
    expect(plain.type).toBe('homework')
    expect(plain.body).toContain('数学')
    expect(plain.url).toBe('/homework')
  })

  it('注销订阅后不再收到推送', async () => {
    await inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      payload: { endpoint: ep('/s') },
      headers: { authorization: `Bearer ${stuToken}` },
    })
    gw.captured.length = 0
    // 不带排除设备：剩余的 T1 / 管理员订阅都应收到
    await pushClass(env, classId, { type: 'message', title: 't', body: 'b' })
    expect(gw.captured.map((r) => r.path).sort()).toEqual(['/a', '/t1'])
  })

  it('未配置 VAPID 时推送关闭且静默跳过', async () => {
    const noKeyEnv = { DB: env.DB, ARK_BOOTSTRAP_CODE: 'TESTBOOT' }
    expect(pushEnabled(noKeyEnv as any)).toBe(false)
    gw.captured.length = 0
    await pushClass(noKeyEnv as any, classId, { type: 'message', title: 't', body: 'b' })
    expect(gw.captured).toHaveLength(0)
  })

  it('清理网关', async () => {
    await gw.close()
  })
})
