<div align="center">

# Ark Class Hub · Server

**方舟班级中心 · 后端 API** —— Hono on Cloudflare Workers + D1（边缘 SQLite）+ Durable Objects（实时通道）

*[前端仓库 ArkClassHub-Web](https://github.com/EasonXia7369/ArkClassHub-Web) · API 地址 [arkapi.macrostar.top](https://arkapi.macrostar.top)*

</div>

## 架构

```
Cloudflare Workers (Hono)
 ├─ D1 (ark)            全部业务数据，SQLite 语义，迁移自动应用
 ├─ Durable Objects     每班一个 ClassChatDO：WebSocket Hibernation
 │                      实时广播聊天消息与数据变更刷新信号
 └─ Secrets/Vars        ARK_BOOTSTRAP_CODE（首个管理员引导码）
```

**CORS 白名单**：`https://ach.macrostar.top`（生产前端）、`http://localhost:5173`（开发）

## API 概览

| 分组 | 端点 | 权限 |
|------|------|------|
| 认证 | 激活（邀请码/引导码）、登录、登出、改密 | 公开 / 会话 |
| 班级 | CRUD、名单增删改查、**批量导入**、科目、学生密码、重命名 | 班主任 / 管理员 |
| 考勤 | 批量登记（present 不落盘）、月度统计（按天/按次） | 教师 / 学生可登记 |
| 请假 | 学生申请 → 老师审批（批准自动展开多天考勤）、撤销 | 按角色 |
| 作业 | 未交登记（软删）、作业布置（增改清空）、**学生与老师同权** | 班主任 / 学生 |
| 值日表 | 按周排班（覆盖式）、今日值日生 | 教师排班 / 学生只读 |
| 课程表 | 按周覆盖编辑、今日课程；**CSES v1 导入导出**（前端实现） | 教师编辑 / 学生只读 |
| 周报 | 区间聚合（考勤按天统计 + 请假 + 作业未交） | 教师 / 管理员 |
| 消息 | 班级群文字/图片/语音（BLOB ≤400KB）、WebSocket 实时通道、历史增量 | 班主任 + 学生 |
| 实时刷新 | 数据变更广播 `{type:'refresh', scope}`，全端自动重拉 | 内部 |
| 管理 | 邀请码、账号列表/**重置任意账号密码**/**班级转让**、旧数据导入 | 管理员 |

**权限模型**：管理员（全局）→ 班主任（本班全部）→ 学生令牌（一体机受限写入，操作按角色留痕到审计日志）。权限校验全部在服务端强制执行。

## 数据库

10 张表（users / sessions / invite_codes / classes / students / attendance / leaves / homework_records / homework_tasks / duty_roster / timetable / audit_logs / messages），迁移文件在 `migrations/`。

- **部署时自动应用**（CI 流水线包含 `d1 migrations apply --remote`）
- 本地需手动：`npx wrangler d1 migrations apply ark --local`
- 备份：应用内「班级设置 → 下载备份 JSON」，或 `npx wrangler d1 export ark --remote`

## 本地开发

```bash
npm install
npx wrangler d1 migrations apply ark --local   # 首次：本地建表
npm run dev        # wrangler dev @ :8787
```

- 引导码在 `.dev.vars`（已 gitignore），用于激活首个管理员
- 前端仓库 `npm run dev`（:5173，/api 代理到 :8787）
- 本地 D1 数据独立存储于 `.wrangler/state`

## 测试

```bash
npm test           # 57 个集成测试
```

测试通过 `test/helpers.ts` 以内存 better-sqlite3 模拟 D1 接口（含 `?N` 编号占位符转换与 batch 原子性模拟），`app.request()` 直接调用 Hono 应用，无需启动网络服务。

## 部署

push 到 `main` → GitHub Actions：类型检查 → **D1 迁移** → `wrangler deploy`（需仓库 Secret `CF_API_TOKEN`）。

## 密码兼容说明

- 现行格式：`pbkdf2:`（Web Crypto PBKDF2-SHA256，10 万轮）
- 兼容：旧考勤 demo 的学生密码 `legacy-sha256:`（一体机登录可用）
- 不兼容：旧 Node 版 scrypt 教师密码（需邀请码重新激活）

## 相关仓库

- [ArkClassHub-Web](https://github.com/EasonXia7369/ArkClassHub-Web) — 前端（Cloudflare Pages）
- [Ark-Class-Hub](https://github.com/EasonXia7369/Ark-Class-Hub) — 原型存档

## 协议

GPL-3.0
