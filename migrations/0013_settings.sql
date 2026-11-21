-- 系统设置 KV 表：目前存 AI 配置（key='ai'，value=JSON {apiKey, baseUrl, model}）。
-- 优先级高于部署级 Env secret（Cloudflare wrangler secret / 自托管 config.json）。
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
