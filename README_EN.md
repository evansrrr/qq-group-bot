# qq-group-bot

A QQ group chatbot running on **Cloudflare Workers**. Mention it in a group and it replies; with full-message mode enabled it also chimes in on its own now and then.

No server required — one Worker is enough. The LLM layer supports **multi-provider failover**, image understanding, smart web search, quoted-message context, and multi-part replies that feel like someone typing.

> 中文说明见 [README.md](./README.md)

## Features

- **Zero server** — runs within the Cloudflare Workers free tier
- **Provider failover** — DeepSeek first, then a chain of free GLM models; any failure falls through to the next
- **Image understanding** — group images are downloaded, base64-encoded, and sent to a vision model (up to 3 per message)
- **Smart web search** — a cheap LLM call decides whether the message needs live info; search only runs when needed
- **Quoted messages** — quoted content (`message_type=103`) is injected as context
- **Multi-part replies** — the model may split a reply into 2–3 messages with a `---` separator
- **Proactive chime-in** — optional probabilistic replies; always replies when its alias is mentioned
- **Persistent memory (D1)** — every group message is stored in Cloudflare D1, per-group isolated
- **Recall & summarize** — `/recall keyword` searches the archive, `/summary` compacts it into a 400-word long-term memory, `/profile name` shows member stats
- **Signature verification** — Ed25519 webhook signing and automatic `op=13` callback validation

## Quick start

```bash
git clone https://github.com/<you>/qq-group-bot.git
cd qq-group-bot
npm install
cp .dev.vars.example .dev.vars   # fill in your keys
npm run dev                      # http://127.0.0.1:8787
```

## Setup the database

```bash
npm run db:create        # copy the printed database_id into wrangler.jsonc
npm run db:migrate:local # local tables (the Worker also creates them lazily)
```

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `QQ_APP_ID` | ✅ | QQ Open Platform app id |
| `QQ_BOT_SECRET` | ✅ | Bot secret, also used to derive the Ed25519 key |
| `DEEPSEEK_API_KEY` | either | Preferred provider; also enables web search |
| `GLM_API_KEY` | either | Zhipu fallback provider |
| `DEEPSEEK_MODEL` | | Defaults to `deepseek-flash` |
| `GLM_MODELS` | | Comma-separated model chain |
| `BOT_PROMPT` | | Overrides `src/prompt/persona.txt` |
| `BOT_ALIASES` | | Comma-separated aliases that always trigger a reply |
| `CHIME_RATE` | | Chime-in probability, `0`–`1`, default `0.3` |

## Deploy

```bash
npx wrangler login
npx wrangler secret put QQ_APP_ID
npx wrangler secret put QQ_BOT_SECRET
npx wrangler secret put DEEPSEEK_API_KEY
npm run deploy
```

Then in the QQ Open Platform console, choose **Webhook** delivery, set the callback to
`https://<your-host>/qq/webhook`, and subscribe to `GROUP_AT_MESSAGE_CREATE`
(plus `GROUP_MESSAGE_CREATE` if you want proactive chime-in).

## How memory works

| Table | Purpose |
| --- | --- |
| `messages` | Raw turns, capped at 500 per group |
| `summaries` | Rolling 400-word group memory, refreshed every 40 new messages |
| `members` | Per-member counters (turns, chars, first/last seen, last line) |
| `seen` | Event de-duplication, 10-minute TTL |

Retrieval is keyword-based (`LIKE` pushed down to SQL, scored in memory), 5 hits max per turn. Compaction runs in `ctx.waitUntil` so it never blocks a reply.

See [docs/ROADMAP.md](./docs/ROADMAP.md) for further directions (member personas, group style profiles, slang dictionary, weekly reports, semantic retrieval).

## Test

```bash
npm run typecheck
npm test
npm run smoke   # end-to-end with mocked upstream services, no real keys needed
```

## License

[MIT](./LICENSE)
