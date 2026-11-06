# qq-group-bot

A QQ group bot on Cloudflare Workers. Mention it and it replies; with full-message mode on, it also chimes in on its own. Chat history lives in D1, so asking "what did we say about that trip last week" days later still works.

One Worker, no server. DeepSeek is the primary model, with free GLM models as fallback. Images, quoted messages, and web search are supported.

Chinese docs: [README.md](./README.md).

## Run locally

```bash
git clone https://github.com/evansrrr/qq-group-bot.git
cd qq-group-bot
npm install
cp .dev.vars.example .dev.vars   # app id, bot secret, at least one model key
npm run db:create                # copy the printed database_id into wrangler.jsonc
npm run db:migrate:local         # optional; tables are created lazily
npm run dev
```

`curl http://127.0.0.1:8787/health` returns `ok`. The placeholder `database_id` in `wrangler.jsonc` is fine locally, but must be replaced before deploying.

## Config

`QQ_APP_ID` and `QQ_BOT_SECRET` are required. Set at least one of `DEEPSEEK_API_KEY` / `GLM_API_KEY`; with both, requests fall through DeepSeek to the free GLM models. In production use `npx wrangler secret put <NAME>`.

| Variable | Purpose |
| --- | --- |
| `BOT_PROMPT` | Overrides the default persona |
| `BOT_ALIASES` | Names that always trigger a reply, default `小鲸,鲸鱼,机器人` |
| `CHIME_RATE` | Chime-in probability, default `0.3`; `0` means reply only when mentioned |
| `ADMIN_OPENIDS` | `member_openid`s allowed to wipe memory or redo a portrait |
| `PORTRAIT_EVERY` / `STYLE_EVERY` | Portrait / group-style cadence, default 20 / 150 messages |
| `IDLE_AFTER_MIN` / `IDLE_MAX_WAIT_MIN` | Silence threshold and random cap, default 30 / 300 minutes |
| `EMBEDDING_API_KEY` | Enables semantic recall; without it, keywords only |

All variables and defaults are listed in `.dev.vars.example`. D1 is a binding in `wrangler.jsonc`, not an env var.

## Talking to it

No slash commands. Just mention it in plain words:

- "还记得日本旅游吗" / "查一下之前的记录 显卡" — pull up old messages
- "总结一下群里最近聊的" — long-term summary
- "张三是什么样的人" — member portrait and stats
- "清空这个群的记忆" / "重新给张三做个画像" — admins only
- "你能做什么" — help

Intents are matched with regex (`src/intent.ts`), not an LLM: cheaper and predictable. To find your `member_openid` for the admin list, say "清空这个群的记忆" in the group and read it from `npx wrangler tail`.

## Memory

D1 is isolated per group. Each group keeps the latest 500 messages; every 40 unsummarized messages trigger a 400-character rolling summary in the background, plus member counters and a dedupe table. A reply gets the last 20 messages, the summary, and recalled lines. Recall is SQL `LIKE` first, with embeddings only when fewer than 2 lines hit. Summaries, portraits, group style, and embeddings all run in `waitUntil` so they never block a reply.

Portraits refresh every 20 messages per member (stops at 100), group style every 150 messages. After 30 minutes of silence a cron job picks a random moment in the next 5 hours to say something; it does not reschedule until someone speaks again. The cron runs every minute — remove `triggers` from `wrangler.jsonc` to disable it.

Images are base64-encoded for the current vision request only; they are never stored.

## Deploy

```bash
npx wrangler login
npm run db:migrate
npx wrangler secret put QQ_APP_ID
npx wrangler secret put QQ_BOT_SECRET
npx wrangler secret put DEEPSEEK_API_KEY
npm run deploy
```

On the first deploy, run `npm run db:create` first and put the real `database_id` into `wrangler.jsonc`. The default host is `https://<worker-name>.<subdomain>.workers.dev`; the callback is `https://<your-host>/qq/webhook`, and QQ only allows ports 80/443/8080/8443. Uncomment `routes` in `wrangler.jsonc` to use a custom domain.

Create the bot at [q.qq.com](https://q.qq.com/), choose Webhook delivery, and subscribe to `GROUP_AT_MESSAGE_CREATE`. For chime-ins, also enable full-message delivery and `GROUP_MESSAGE_CREATE`. The `op=13` callback check is answered automatically with a key derived from the bot secret.

## Persona

Edit `src/prompt/persona.txt` or override it with `BOT_PROMPT`. Tell the model to keep replies to two short sentences with no lists or customer-service tone. A line containing only `---` splits one reply into several messages.

## Tests

```bash
npm run typecheck
npm test
npm run smoke
```

`smoke` starts a local Worker with mocked upstreams, so it costs nothing; ports 8787 and 9099 must be free, and `.dev.vars` is restored afterwards.

## Caveats

- Idle messages need QQ's proactive-message quota; when it runs out, sending fails and the plan is dropped.
- Passive replies are capped at 5 per message within 5 minutes, so long text is cut into at most 4 chunks of 500 characters.
- Images are downloaded into Worker memory — watch the memory and CPU limits.
- Group messages only. DMs, voice, and video are not supported.
- Early portraits are based on few samples and can turn a joke into a personality trait; admins can redo them.

Start at `src/index.ts` (signature check, dispatch, sending); memory lives in `src/memory/`, and provider failover in `src/llm.ts`.

MIT, see [LICENSE](./LICENSE). Contribution notes in [CONTRIBUTING.md](./CONTRIBUTING.md). Tell group members that messages are read, follow the QQ Open Platform rules, and don't use it for spam.
