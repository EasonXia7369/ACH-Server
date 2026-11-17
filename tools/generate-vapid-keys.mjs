// 生成 Web Push VAPID 密钥对（P-256，web-push generate-vapid-keys 同格式）。
// 用法：node tools/generate-vapid-keys.mjs
// 输出直接可写入 .dev.vars（本地）或 `wrangler secret put`（生产）。
import { webcrypto as c } from 'node:crypto'

const pair = await c.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
])
const rawPub = Buffer.from(await c.subtle.exportKey('raw', pair.publicKey))
const jwk = await c.subtle.exportKey('jwk', pair.privateKey)

console.log('VAPID_PUBLIC_KEY=' + rawPub.toString('base64url'))
console.log('VAPID_PRIVATE_KEY=' + jwk.d)
console.log('# 生产环境：npx wrangler secret put VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY')
