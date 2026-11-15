# Ark Class Hub · Server（后端 API）

方舟班级中心的后端：Hono on Cloudflare Workers + D1（边缘 SQLite）。配合前端仓库 [`Ark-Class-Hub-Web`](https://github.com/EasonXia7369/ArkClassHub-Web) 使用。

- API 地址：https://arkapi.macrostar.top（push 到 main 自动部署）
- CORS 白名单：`https://ark.macrostar.top`（生产）、`http://localhost:5173`（开发）

## 本地开发

```bash
npm install
npx wrangler d1 migrations apply ark --local   # 首次：本地建表
npm run dev        # wrangler dev @ :8787（引导码在 .dev.vars，已 gitignore）
```

前端仓库 `npm run dev`（:5173，/api 代理到 :8787）。

## 测试

```bash
npm test           # 35 个集成测试（内存 SQLite 模拟 D1 接口）
```

## 部署

push 到 `main` → GitHub Actions 自动类型检查 + `wrangler deploy`（需要仓库 Secret：`CLOUDFLARE_API_TOKEN`）。

表结构变更：`migrations/` 下新增编号 SQL → Actions 部署**不会**自动跑迁移，需手动：

```bash
npx wrangler d1 migrations apply ark --remote
```

## 协议

GPL-3.0
