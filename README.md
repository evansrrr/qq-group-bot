# qq-group-bot

跑在 Cloudflare Workers 上的 QQ 群机器人。@ 它就回话，开了「接收所有消息」也会偶尔自己接话。聊天记录存在 D1，隔几天问它「还记得日本旅游吗」能翻出原话。

一个 Worker 就够，不用服务器。模型先走 DeepSeek，失败自动降到智谱 GLM 免费档；图片、引用消息、联网搜索都支持。

英文说明见 [README_EN.md](./README_EN.md)。

## 本地跑起来

```bash
git clone https://github.com/evansrrr/qq-group-bot.git
cd qq-group-bot
npm install
cp .dev.vars.example .dev.vars   # 填 AppID、BotSecret、至少一个模型 key
npm run db:create                # 把输出的 database_id 填进 wrangler.jsonc
npm run db:migrate:local         # 可跳过，代码会自己补表
npm run dev
```

`curl http://127.0.0.1:8787/health` 返回 `ok` 就通了。`wrangler.jsonc` 里的 `database_id` 是占位值，本地跑不用管，上线前必须换成自己的。

## 配置

必填 `QQ_APP_ID`、`QQ_BOT_SECRET`；`DEEPSEEK_API_KEY` 和 `GLM_API_KEY` 至少配一个，两个都配才走完整的降级链。线上用 `npx wrangler secret put <名字>` 写，别提交进仓库。

常改的几个：

| 变量 | 用途 |
| --- | --- |
| `BOT_PROMPT` | 覆盖默认人格提示词 |
| `BOT_ALIASES` | 逗号分隔的昵称，被提到必接话，默认 `小鲸,鲸鱼,机器人` |
| `CHIME_RATE` | 随机插话概率，默认 0.3；设 0 就只在被 @ 时说话 |
| `ADMIN_OPENIDS` | 管理员 `member_openid`，清空记忆、重做画像要靠它 |
| `PORTRAIT_EVERY` / `STYLE_EVERY` | 画像 / 群风格更新频率，默认 20 / 150 条 |
| `IDLE_AFTER_MIN` / `IDLE_MAX_WAIT_MIN` | 冷场多久后开口、随机等待上限，默认 30 / 300 分钟 |
| `EMBEDDING_API_KEY` | 语义检索，不配就退回纯关键词 |

其余变量和默认值都在 `.dev.vars.example`。D1 不是环境变量，是 `wrangler.jsonc` 里的 `DB` 绑定。

## 群里怎么说

没有斜杠指令，@ 它一句话就行：

- 「还记得日本旅游吗」「查一下之前的记录 显卡」——翻历史原话
- 「总结一下群里最近聊的」——出一份长期摘要
- 「张三是什么样的人」——成员画像加发言统计
- 「清空这个群的记忆」「重新给张三做个画像」——仅管理员
- 「你能做什么」——能力清单

意图靠正则匹配（`src/intent.ts`），不走模型，便宜也稳定。管理员白名单为空时，先在群里说一句「清空这个群的记忆」，再去 `npx wrangler tail` 里抄自己的 `member_openid`。

## 记忆

D1 按群隔离。每群留最近 500 条原文，攒够 40 条没摘要的就在后台压一次 400 字摘要，另外记成员统计和消息去重。回复前取最近 20 条 + 摘要 + 检索命中的旧话；检索先用 SQL `LIKE`，命中不到 2 条才调 embedding 补语义。摘要、画像、群风格、向量化全放 `waitUntil`，不挡回话。

成员每 20 条发言画一次像，满 100 条停；群消息每 150 条更新一次说话风格。静默 30 分钟后，cron 在之后 0~5 小时里挑个时间点主动说一句，发过就不再排，等有人重新说话。cron 每分钟跑一次，不需要就把 `wrangler.jsonc` 的 `triggers` 删掉。

图片只在当次请求里转 base64 发给视觉模型，不入库。

## 部署

```bash
npx wrangler login
npm run db:migrate
npx wrangler secret put QQ_APP_ID
npx wrangler secret put QQ_BOT_SECRET
npx wrangler secret put DEEPSEEK_API_KEY
npm run deploy
```

首次部署先 `npm run db:create` 换掉占位的 `database_id`，再跑 `db:migrate`。默认地址是 `https://<worker-name>.<subdomain>.workers.dev`，回调填 `https://<你的域名>/qq/webhook`，平台只放行 80/443/8080/8443 端口。要绑自定义域名，把 `wrangler.jsonc` 里注释掉的 `routes` 打开改成自己的。

到 [q.qq.com](https://q.qq.com/) 创建机器人，消息接收选 Webhook，填回调地址，订阅 `GROUP_AT_MESSAGE_CREATE`。想让它插话，再开「接收所有消息」并订阅 `GROUP_MESSAGE_CREATE`。保存时平台下发的 `op=13` 验证，Worker 会用 BotSecret 派生私钥自动签名应答。

## 改人格

直接改 `src/prompt/persona.txt`，或用 `BOT_PROMPT` 整个覆盖，不用碰代码。提示词里写清楚「最多两句、不要列点、不要客服腔」，否则群里会冒出大段文本；允许用单独一行 `---` 分隔，它就会拆成几条连着发。

## 测试

```bash
npm run typecheck
npm test
npm run smoke
```

`smoke` 会起本地 Worker、mock 掉上游跑完整链路，不产生真实 API 费用；需要 8787 和 9099 端口空闲，跑完会还原 `.dev.vars`。

## 几个坑

- 冷场主动消息要 QQ 开放平台的主动消息额度，用完就发不出去，日志里能看到。
- 被动回复每条消息 5 分钟内最多 5 次，长回复会按 500 字切成最多 4 条。
- 图片下载到 Worker 内存转 base64，注意内存和 CPU 时间上限。
- 只处理群消息，单聊、语音、视频不支持。
- 画像样本少的时候容易把一次玩笑写成人设，管理员可以重做。

代码入口 `src/index.ts`（验签、分发、发送），记忆相关都在 `src/memory/`，模型降级链在 `src/llm.ts`。

MIT，见 [LICENSE](./LICENSE)；贡献流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。机器人会读群消息，用之前在群里说一声；遵守 QQ 开放平台规范，别拿来群发广告。
