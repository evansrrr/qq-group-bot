# qq-group-bot

一个跑在 **Cloudflare Workers** 上的 QQ 官方群聊机器人：群里 @ 它就能聊天，不 @ 它也会偶尔自己接话。

后端极轻（单个 Worker，无需服务器），LLM 支持**多供应商故障转移**，并且带图片理解、联网搜索、引用消息理解、多段消息回复。

> English: [README_EN.md](./README_EN.md)

---

## 特性

| 能力 | 说明 |
| --- | --- |
| 🪶 零服务器 | 部署在 Cloudflare Workers 免费额度内即可运行，无需 VPS |
| 🔁 多供应商故障转移 | DeepSeek 首选 → 智谱 GLM 免费模型链兜底；任一档失败自动降级下一档 |
| 🖼 图片理解 | 群里发的图片下载后转 base64 交给视觉模型（每条最多 3 张） |
| 🌐 智能联网搜索 | 先用一次轻量 LLM 判断"这条要不要查实时信息"，需要才调搜索 API，省 token |
| 💬 引用消息理解 | `message_type=103` 的被引用内容会作为上下文注入 |
| ⌨️ 真人式多段回复 | 模型偶尔用 `---` 把回复拆成 2~3 条逐条发送，像连续打字 |
| 🗣 主动插话 | 可选：开启全量消息后，按概率随机接话；提到昵称必接 |
| 🧠 群级记忆 | 每个群独立 20 条上下文，30 分钟过期；发 `/reset` 清空 |
| 🔐 回调验签 | Ed25519 验签 + `op=13` 回调地址验证自动应答 |

## 架构

```
QQ 群消息（@机器人 / 全量消息）
   │  HTTPS webhook(Ed25519 签名)
   ▼
Cloudflare Worker  POST /qq/webhook
   ├─ 验签 → ACK(op=12) → 去重
   ├─ 归一化内容：文本 / 图片 / 引用
   ├─ 搜索意图判断（轻量 LLM 调用，Y/N）
   │     └─ Y → 搜索 API → 结果注入 system
   ├─ LLM 对话：DeepSeek → GLM 免费档链（逐档降级）
   └─ QQ OpenAPI 被动回复（msg_id，5 分钟内有效）
```

## 快速开始

```bash
git clone https://github.com/<you>/qq-group-bot.git
cd qq-group-bot
npm install

cp .dev.vars.example .dev.vars   # 填入你的密钥
npm run dev                      # http://127.0.0.1:8787
```

验证是否跑起来：

```bash
curl http://127.0.0.1:8787/health   # → ok
```

## 配置

本地开发写在 `.dev.vars`，线上用 `wrangler secret put` / `wrangler.jsonc` 的 `vars`。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `QQ_APP_ID` | ✅ | QQ 开放平台 AppID |
| `QQ_BOT_SECRET` | ✅ | BotSecret，同时用于 Ed25519 验签 |
| `DEEPSEEK_API_KEY` | 二选一 | 配置后作为首选供应商，并启用联网搜索 |
| `GLM_API_KEY` | 二选一 | 智谱开放平台 key，作为兜底 |
| `DEEPSEEK_MODEL` | | 默认 `deepseek-flash` |
| `GLM_MODELS` | | 逗号分隔模型链，默认 `glm-4.7-flash,GLM-4-Flash-250414,GLM-Z1-Flash` |
| `BOT_PROMPT` | | 人格提示词，整体覆盖 `src/prompt/persona.txt` |
| `BOT_ALIASES` | | 逗号分隔昵称，提到就必接话；默认 `小鲸,鲸鱼,机器人` |
| `CHIME_RATE` | | 主动插话概率 0~1，默认 `0.3`；设 `0` 即只在被叫到时说话 |
| `QQ_API_BASE` / `GLM_BASE_URL` / `DEEPSEEK_BASE_URL` | | 仅本地联调/冒烟测试覆盖，生产不要配 |

`DEEPSEEK_API_KEY` 和 `GLM_API_KEY` 至少配一个；两个都配则走完整故障转移链。

## 部署

### 1. 部署 Worker

```bash
npx wrangler login
npx wrangler secret put QQ_APP_ID
npx wrangler secret put QQ_BOT_SECRET
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put GLM_API_KEY        # 可选，兜底
npm run deploy
```

默认使用 `https://<worker-name>.<subdomain>.workers.dev`。想绑自定义域名，把 `wrangler.jsonc` 里注释掉的 `routes` 打开并改成你的域名。

### 2. 在 QQ 开放平台创建机器人

1. 到 [q.qq.com](https://q.qq.com/) 注册开发者并创建机器人，拿到 `AppID` / `BotSecret`
2. 消息接收方式选 **Webhook**，回调地址填 `https://<你的地址>/qq/webhook`
   （平台只允许 80/443/8080/8443 端口）
3. 保存时平台会下发 `op=13` 回调验证，本 Worker 会用 BotSecret 派生私钥自动签名应答
4. 订阅事件：勾选 **`GROUP_AT_MESSAGE_CREATE`**（群 @ 机器人）
   想让机器人主动插话，再开启「接收所有消息」并勾选 **`GROUP_MESSAGE_CREATE`**
5. 把机器人拉进你的群，`@机器人 你好` 即可

## 自定义人格

人格是纯文本，改 `src/prompt/persona.txt` 即可，或用 `BOT_PROMPT` 环境变量整体覆盖（改完不用改代码）。

几句经验：

- **写短句**，明确告诉模型"最多两句、不要列点、不要分段"，否则群聊里会出现大段文本
- **明确禁止客服腔**，否则模型默认输出"您好，有什么可以帮您"
- 需要联网时不要把搜索结果抄给用户，告诉它"自然融入口语化回复"
- 想让它多段回复，就在提示词里说明可用单独一行 `---` 分隔

## 项目结构

| 路径 | 说明 |
| --- | --- |
| `src/index.ts` | 路由、webhook 验签、事件分发、消息拆分与发送 |
| `src/crypto.ts` | Ed25519 回调验签 / `op=13` 回调地址验证签名 |
| `src/qq.ts` | access_token 获取缓存、发送群消息 |
| `src/llm.ts` | LLM 客户端（供应商感知的故障转移链、视觉降级） |
| `src/search.ts` | 搜索意图判断 + 搜索 API 调用 + 结果注入格式化 |
| `src/vision.ts` | 图片下载转 base64，失败回退原始 URL |
| `src/state.ts` | 群会话历史（20 条 / 30 分钟 TTL）、消息去重、昵称匹配 |
| `src/env.ts` | 环境变量与消息类型定义 |
| `src/prompt/persona.txt` | 默认人格提示词 |
| `scripts/smoke.mjs` | 端到端冒烟测试（本地 mock 上游，不花钱） |
| `test/` | 单元测试（含官方签名测试向量） |

## 测试

```bash
npm run typecheck   # 类型检查
npm test            # 单元测试
npm run smoke       # 端到端冒烟：真实起 wrangler dev + mock 上游
```

`npm run smoke` 会自动备份你的 `.dev.vars`、换成测试配置、跑完整链路（健康检查 / op=13 / 验签 / 401 / 去重 / `/reset` / 插话 / 搜索 / 分段发送 / 引用），结束后恢复。它需要 8787 与 9099 端口空闲。

## 已知限制

- **会话历史在 Worker 实例内存里**，多实例之间不共享；Worker 冷启动会丢记忆。小群够用，要大群持久化请换 Durable Objects 或 KV
- **被动回复限制**：每条消息 5 分钟内最多回 5 次，所以超长回复会被按 500 字切成最多 4 条
- 只处理群消息；单聊、语音、视频等富媒体暂不支持（会以占位文本告诉模型）
- 图片会下载到 Worker 内存转 base64，注意 Worker 内存与 CPU 时间上限

## 排错

| 现象 | 排查 |
| --- | --- |
| 回调地址验证失败 | `npx wrangler tail` 看日志，确认 `QQ_BOT_SECRET` 与平台一致 |
| 事件推送 401 | 验签失败 = secret 不匹配，或 body 被中间层改写 |
| 群里 @ 没反应 | 看 tail 是否收到事件；再看发送错误码（如消息 ID 过期、机器人不在群） |
| LLM 一直失败 | 日志会打印 `model=xxx http=yyy`，据此查对应平台的 key/配额/模型名 |
| 发出去是空或截断 | 检查提示词是否要求了 Markdown 或过长输出 |

## 免责声明

本项目仅用于学习与自娱。使用前请阅读并遵守 [QQ 开放平台](https://q.qq.com/) 的开发者规范：

- 不要把机器人用于群发广告、刷屏、骚扰或任何违规用途
- 群机器人会读取群消息内容，请在群内明确告知成员
- 模型输出不代表本项目立场，请在提示词中加好安全约束

## License

[MIT](./LICENSE)
