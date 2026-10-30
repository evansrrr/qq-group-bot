/**
 * 端到端冒烟测试:
 * 1. 起本地 mock(QQ OpenAPI + 智谱 chat/completions)
 * 2. 起真实 wrangler dev(worker 通过 GLM_BASE_URL/QQ_API_BASE 指到 mock)
 * 3. 校验:健康检查 / op=13 回调验证 / 验签 / 401 / 事件处理 / 去重 / 自然语言清空
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";

const WORKER_PORT = 8787;
const MOCK_PORT = 9099;
const SECRET = "test_bot_secret_0123456789"; // 必须与下方 SMOKE_VARS 的 QQ_BOT_SECRET 一致
// 每次运行使用全新群号：本地 D1 会持久化，复用固定群号会让上一轮的历史污染断言
const RUN_ID = Date.now().toString(36);
const G = (n) => `GRP${n}-${RUN_ID}`;
// 用于兜底清理残留进程时匹配本项目路径，跨机器/改目录名都能命中
const PROJECT_DIR = basename(fileURLToPath(new URL("..", import.meta.url)));

const VARS_PATH = fileURLToPath(new URL("../.dev.vars", import.meta.url));
// 冒烟专用配置:临时替换 .dev.vars,禁用 DeepSeek 以免打到真实 API;结束后恢复原文件
const SMOKE_VARS = [
  "QQ_APP_ID=10000000",
  `QQ_BOT_SECRET=${SECRET}`,
  "DEEPSEEK_API_KEY=test_deepseek_key",
  "DEEPSEEK_BASE_URL=http://127.0.0.1:9099",
  "GLM_API_KEY=test_glm_key",
  "GLM_BASE_URL=http://127.0.0.1:9099",
  "QQ_API_BASE=http://127.0.0.1:9099",
  "CHIME_RATE=1",
  "ADMIN_OPENIDS=ADMIN1",
  "PORTRAIT_EVERY=2",
  "PORTRAIT_MAX=6",
  "PORTRAIT_MIN_SAMPLES=2",
  "STYLE_EVERY=4",
  "STYLE_MIN_SAMPLES=2",
  "IDLE_AFTER_MIN=0",
  "IDLE_MAX_WAIT_MIN=0",
  "IDLE_MIN_MSGS=1",
  "EMBEDDING_BASE_URL=http://127.0.0.1:9099",
  "EMBEDDING_MODEL=test-embed",
  "",
].join("\n");

const received = { llm: [], sends: [], tokens: 0, searches: [], embeddings: [] };
let failures = 0;

function assert(cond, name) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 15000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(200);
  }
  console.log(`  FAIL timeout waiting for ${label}`);
  failures++;
  return false;
}

const systemOf = (c) => c.body.messages?.[0]?.content ?? "";
const isDecision = (c) => systemOf(c).includes("搜索意图判断器");
const isSummary = (c) => systemOf(c).includes("长期记忆摘要");
const isPortrait = (c) => systemOf(c).includes("整理某个群成员的画像");
const isStyle = (c) => systemOf(c).includes("总结一个 QQ 群的说话风格");
const isAux = (c) => isSummary(c) || isPortrait(c) || isStyle(c);
const answers = () => received.llm.filter((c) => !isDecision(c) && !isAux(c));
const decisions = () => received.llm.filter(isDecision);

/**
 * 清掉本项目的残留 wrangler dev / workerd(taskkill 树在 Windows 上常杀不干净,
 * 残留进程会抢占 8787 导致事件被路由到旧 worker,结果随机)。
 */
function killStrayDevs() {
  const ps = [
    "$pids = @()",
    // 只清 8787(9099 是本进程 mock,绝不能杀)
    "$pids += Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique",
    "Get-CimInstance Win32_Process | Where-Object {",
    `  $_.CommandLine -like '*${PROJECT_DIR}*' -and $_.Name -in @('node.exe','cmd.exe','workerd.exe')`,
    "  -and ($_.CommandLine -like '*wrangler*' -or $_.CommandLine -like '*workerd*')",
    "} | ForEach-Object { $pids += $_.ProcessId }",
    "$pids = @($pids | Where-Object { $_ -ne $PID -and $_ -ne " + process.pid + " } | Select-Object -Unique)",
    "$pids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
  ].join("\n");
  spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
}

function startMock() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/app/getAppAccessToken") {
          received.tokens++;
          res.end(JSON.stringify({ access_token: "MOCK_TOKEN", expires_in: 7200 }));
        } else if (req.url?.startsWith("/v2/groups/") && req.url.endsWith("/messages")) {
          received.sends.push({ path: req.url, body: parsed, auth: req.headers.authorization });
          res.end(JSON.stringify({ id: "sent_1", timestamp: "2026-01-01T00:00:00+08:00" }));
        } else if (req.url === "/embeddings") {
          received.embeddings.push(parsed);
          // 固定向量:让任意查询与任意历史都足够相似,便于验证语义召回通路
          res.end(JSON.stringify({ data: [{ embedding: [1, 0.5, 0.25, 0, 0, 0, 0, 0] }] }));
        } else if (req.url === "/v1/tools/search") {
          received.searches.push(parsed);
          res.end(
            JSON.stringify({
              results: [
                {
                  title: "北京今日天气预报",
                  url: "https://example.com/bj-weather",
                  summary: "北京今天晴,3℃~17℃,西北风3级,空气质量优。",
                  date: "2026-10-17T00:00:00+00:00",
                },
              ],
            }),
          );
        } else if (req.url?.endsWith("/chat/completions")) {
          received.llm.push({ body: parsed, auth: req.headers.authorization });
          const sys0 = parsed.messages?.[0]?.content ?? "";
          const last = parsed.messages?.[parsed.messages.length - 1]?.content;
          const lastText =
            typeof last === "string"
              ? last
              : Array.isArray(last)
                ? last.filter((p) => p.type === "text").map((p) => p.text).join(" ")
                : "";
          let content = "mock回复~";
          if (sys0.includes("整理某个群成员的画像")) {
            content = "句子短、爱晒日常、爱用省略号|摸鱼,游戏|话少";
          } else if (sys0.includes("总结一个 QQ 群的说话风格")) {
            content = "清一色短句,爱用省略号,称呼人用佬,不发表情。";
          } else if (sys0.includes("长期记忆摘要")) {
            content = "群友甲爱摸鱼,常在群里晒日常;群友乙偶尔问在吗;群里常聊天气和旅游。";
          } else if (sys0.includes("搜索意图判断器")) {
            content = lastText.includes("天气") ? "Y:北京今日天气" : "N";
          } else if (lastText.includes("拆分测试")) {
            content = "第一条短句\n---\n第二条短句";
          }
          res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        } else {
          res.statusCode = 404;
          res.end("{}");
        }
      });
    });
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

function signHex(msg, secret) {
  const enc = new TextEncoder();
  const seed = new Uint8Array(32);
  const src = enc.encode(secret);
  for (let i = 0; i < 32; i++) seed[i] = src[i % src.length];
  const { secretKey } = nacl.sign.keyPair.fromSeed(seed);
  const sig = nacl.sign.detached(enc.encode(msg), secretKey);
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function postWebhook(bodyStr, { signature, timestamp } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (signature) headers["X-Signature-Ed25519"] = signature;
  if (timestamp) headers["X-Signature-Timestamp"] = timestamp;
  const res = await fetch(`http://127.0.0.1:${WORKER_PORT}/qq/webhook`, {
    method: "POST",
    headers,
    body: bodyStr,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  console.log("[smoke] killing stray wrangler dev / workerd processes...");
  killStrayDevs();

  console.log("[smoke] starting mock server...");
  const mock = await startMock();

  const varsBackup = existsSync(VARS_PATH) ? readFileSync(VARS_PATH, "utf8") : null;
  writeFileSync(VARS_PATH, SMOKE_VARS);
  console.log("[smoke] .dev.vars swapped to smoke config (original backed up in memory)");

  let varsRestored = false;
  const restoreVars = () => {
    if (varsRestored) return;
    varsRestored = true;
    if (varsBackup !== null) writeFileSync(VARS_PATH, varsBackup);
    else rmSync(VARS_PATH, { force: true });
  };
  process.on("exit", restoreVars);

  console.log("[smoke] starting wrangler dev...");
  const wrangler = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(WORKER_PORT), "--test-scheduled"],
    {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  let wranglerLog = "";
  wrangler.stdout.on("data", (d) => (wranglerLog += d));
  wrangler.stderr.on("data", (d) => (wranglerLog += d));

  const cleanup = async () => {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(wrangler.pid), "/T", "/F"]);
      } else {
        wrangler.kill("SIGTERM");
      }
    } catch {}
    // 等 taskkill 树执行后再兜底清理(workerd 常脱离树)
    await new Promise((r) => setTimeout(r, 1500));
    killStrayDevs();
    mock.close();
  };

  try {
    const ready = await waitFor(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${WORKER_PORT}/health`);
          return res.ok;
        } catch {
          return false;
        }
      },
      90000,
      "worker /health",
    );
    if (!ready) {
      console.log("--- wrangler output ---\n" + wranglerLog);
      return;
    }

    console.log("\n[1] 健康检查");
    const health = await (await fetch(`http://127.0.0.1:${WORKER_PORT}/health`)).text();
    assert(health === "ok", "GET /health 返回 ok");

    console.log("\n[2] op=13 回调地址验证");
    const validationBody = JSON.stringify({
      d: { plain_token: "Arq0D5A61EgUu4OxUvOp", event_ts: "1725442341" },
      op: 13,
    });
    const v = await postWebhook(validationBody);
    const expectedSig = signHex("1725442341" + "Arq0D5A61EgUu4OxUvOp", SECRET);
    assert(v.status === 200, "状态码 200");
    assert(v.json?.plain_token === "Arq0D5A61EgUu4OxUvOp", "回显 plain_token");
    assert(v.json?.signature === expectedSig, "signature 与本地重算一致");

    console.log("\n[3] 无签名的事件推送被拒绝");
    const noSig = await postWebhook(
      JSON.stringify({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { id: "X" } }),
    );
    assert(noSig.status === 401, "无签名返回 401");

    console.log("\n[4] 签名被篡改被拒绝");
    const goodEvent = JSON.stringify({
      id: "evt1",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG1",
        content: "你好呀",
        group_openid: G(1),
        author: { username: "测试用户" },
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const tampered = await postWebhook(goodEvent.slice(0, -1) + " }", {
      signature: signHex(ts + goodEvent, SECRET),
      timestamp: ts,
    });
    assert(tampered.status === 401, "篡改 body 返回 401");

    console.log("\n[5] 正常群 @ 消息全链路");
    const ok = await postWebhook(goodEvent, {
      signature: signHex(ts + goodEvent, SECRET),
      timestamp: ts,
    });
    assert(ok.status === 200 && ok.json?.op === 12, "立即 ACK op=12");
    assert(
      await waitFor(() => received.llm.length >= 2 && received.sends.length >= 1, 15000, "LLM+发送"),
      "决策+回答两次 LLM 调用与消息发送完成",
    );
    assert(
      decisions()[0]?.body?.messages?.[0]?.content?.includes("搜索意图判断器"),
      "先发起搜索意图判断(轻量调用)",
    );
    const llm1 = answers()[0]?.body;
    assert(
      llm1?.messages?.some((m) => m.content === "测试用户: 你好呀"),
      "LLM 收到带用户名前缀的用户消息",
    );
    assert(llm1?.messages?.[0]?.role === "system", "首条为 system 提示词");
    assert(llm1?.model === "deepseek-flash", "首选 model=deepseek-flash");
    const send1 = received.sends[0];
    assert(send1?.path === `/v2/groups/${G(1)}/messages`, "发到正确的群接口");
    assert(send1?.body?.msg_id === "MSG1" && send1?.body?.msg_seq === 1, "被动回复 msg_id/msg_seq");
    assert(send1?.body?.content === "mock回复~", "回复内容来自 LLM");
    assert(received.tokens >= 1, "获取过 access_token");

    console.log("\n[6] 重复推送去重");
    await postWebhook(goodEvent, {
      signature: signHex(ts + goodEvent, SECRET),
      timestamp: ts,
    });
    await sleep(3000);
    assert(received.sends.length === 1, "重复事件不重复回复");

    console.log("\n[7] 自然语言清空记忆(需管理员)");
    const nonAdminReset = JSON.stringify({
      id: "evt2",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG2",
        content: "清空这个群的记忆",
        group_openid: G(1),
        author: { username: "测试用户", member_openid: "USER1" },
      },
    });
    await postWebhook(nonAdminReset, {
      signature: signHex(ts + nonAdminReset, SECRET),
      timestamp: ts,
    });
    assert(
      await waitFor(() => received.sends.length >= 2, 10000, "非管理员拒绝回复"),
      "非管理员触发有回复",
    );
    assert(
      String(received.sends[1]?.body?.content ?? "").includes("管理员"),
      "非管理员被拒绝(不清空)",
    );

    const adminReset = JSON.stringify({
      id: "evt2b",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG2B",
        content: "清空这个群的记忆",
        group_openid: G(1),
        author: { username: "群主", member_openid: "ADMIN1" },
      },
    });
    await postWebhook(adminReset, {
      signature: signHex(ts + adminReset, SECRET),
      timestamp: ts,
    });
    assert(
      await waitFor(() => received.sends.length >= 3, 10000, "管理员清空回复"),
      "管理员触发有回复",
    );
    assert(String(received.sends[2]?.body?.content ?? "").includes("清空"), "记忆已清空");

    const afterReset = JSON.stringify({
      id: "evt3",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: { id: "MSG3", content: "继续聊", group_openid: G(1), author: { username: "测试用户" } },
    });
    await postWebhook(afterReset, {
      signature: signHex(ts + afterReset, SECRET),
      timestamp: ts,
    });
    assert(
      await waitFor(() => answers().length >= 2, 10000, "reset 后 LLM 调用"),
      "reset 后再次调用 LLM",
    );
    const msgsAfter = answers()[1]?.body?.messages ?? [];
    assert(
      msgsAfter.length === 2 &&
        msgsAfter[1]?.content === "测试用户: 继续聊",
      "历史已被清空(仅 system + 新消息)",
    );
    assert(
      await waitFor(
        () => received.sends.some((s) => s.body?.msg_id === "MSG3"),
        10000,
        "MSG3 发送完成",
      ),
      "等待 MSG3 实际发出(防止竞态污染后续场景)",
    );

    console.log("\n[8] 全量消息主动插话(CHIME_RATE=1)");
    const sendsBeforeChime = received.sends.length;
    const chimeEvent = JSON.stringify({
      id: "evt4",
      op: 0,
      t: "GROUP_MESSAGE_CREATE",
      d: {
        id: "MSG8",
        content: "今天摸鱼好开心",
        group_openid: G(1),
        author: { username: "群友甲", bot: false },
      },
    });
    await postWebhook(chimeEvent, {
      signature: signHex(ts + chimeEvent, SECRET),
      timestamp: ts,
    });
    assert(
      await waitFor(() => received.sends.length >= sendsBeforeChime + 1, 10000, "插话回复"),
      "非 @ 消息触发主动插话",
    );
    const chimeSend = received.sends[sendsBeforeChime];
    assert(chimeSend?.body?.msg_id === "MSG8", "插话回复对应 MSG8");
    const chimeLlm = answers()[2]?.body;
    assert(
      chimeLlm?.messages?.[0]?.content?.includes("主动插话"),
      "插话时 system 带主动插话提示",
    );
    assert(
      chimeLlm?.messages?.some((m) => m.content === "群友甲: 今天摸鱼好开心"),
      "插话请求包含群友消息上下文",
    );

    const botEvent = JSON.stringify({
      id: "evt5",
      op: 0,
      t: "GROUP_MESSAGE_CREATE",
      d: {
        id: "MSG9",
        content: "我是别的机器人",
        group_openid: G(1),
        author: { username: "机器人乙", bot: true },
      },
    });
    await postWebhook(botEvent, {
      signature: signHex(ts + botEvent, SECRET),
      timestamp: ts,
    });
    await sleep(2000);
    assert(received.sends.length === sendsBeforeChime + 1, "机器人消息被忽略,不触发插话");

    console.log("\n[9] 全量事件带机器人 mention = @消息,必回且防双回");
    const sendsBefore9 = received.sends.length;
    const fullCopy = JSON.stringify({
      id: "evt6",
      op: 0,
      t: "GROUP_MESSAGE_CREATE",
      d: {
        id: "MSG10",
        content: "<@BOTOPENID123> 在吗",
        group_openid: G(2),
        author: { username: "群友乙", bot: false },
        mentions: [{ id: "BOTOPENID123", username: "小鲸", bot: true }],
      },
    });
    await postWebhook(fullCopy, { signature: signHex(ts + fullCopy, SECRET), timestamp: ts });
    assert(
      await waitFor(() => received.sends.length >= sendsBefore9 + 1, 10000, "全量@消息回复"),
      "全量事件中 @机器人 的消息必回",
    );
    assert(received.sends[received.sends.length - 1]?.body?.msg_id === "MSG10", "回复 MSG10");

    const atCopy = JSON.stringify({
      id: "evt7",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG10",
        content: "在吗",
        group_openid: G(2),
        author: { username: "群友乙", bot: false },
      },
    });
    await postWebhook(atCopy, { signature: signHex(ts + atCopy, SECRET), timestamp: ts });
    await sleep(2500);
    assert(received.sends.length === sendsBefore9 + 1, "@ 事件副本被去重,不双回");

    console.log("\n[10] LLM 智能判断触发联网搜索(天气问法)");
    const sendsBefore10 = received.sends.length;
    const weatherEvent = JSON.stringify({
      id: "evt8",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG11",
        content: "北京今天天气怎么样",
        group_openid: G(3),
        author: { username: "群友丙", bot: false },
      },
    });
    await postWebhook(weatherEvent, { signature: signHex(ts + weatherEvent, SECRET), timestamp: ts });
    assert(
      await waitFor(() => received.sends.length >= sendsBefore10 + 1, 15000, "天气回复"),
      "天气问法得到回复",
    );
    assert(
      received.searches.length >= 1 &&
        (received.searches[received.searches.length - 1]?.query ?? "").includes("北京"),
      "Search API 被调用且查询含关键词",
    );
    const weatherAnswer = answers()[answers().length - 1]?.body;
    assert(
      weatherAnswer?.messages?.some(
        (m) => typeof m.content === "string" && m.content.includes("联网搜索结果"),
      ),
      "搜索结果已注入回答请求",
    );
    assert(received.sends[received.sends.length - 1]?.body?.msg_id === "MSG11", "回复 MSG11");

    console.log("\n[11] 回复偶尔拆成多条消息发送(--- 分隔)");
    const sendsBefore11 = received.sends.length;
    const splitEvent = JSON.stringify({
      id: "evt9",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG12",
        content: "拆分测试一下",
        group_openid: G(4),
        author: { username: "群友丁", bot: false },
      },
    });
    await postWebhook(splitEvent, { signature: signHex(ts + splitEvent, SECRET), timestamp: ts });
    assert(
      await waitFor(() => received.sends.length >= sendsBefore11 + 2, 15000, "两条分开发"),
      "拆分回复逐条发送",
    );
    const sendA = received.sends[sendsBefore11];
    const sendB = received.sends[sendsBefore11 + 1];
    assert(sendA?.body?.msg_id === "MSG12" && sendA?.body?.msg_seq === 1, "第一条 msg_seq=1");
    assert(sendB?.body?.msg_id === "MSG12" && sendB?.body?.msg_seq === 2, "第二条 msg_seq=2");
    assert(sendA?.body?.content === "第一条短句", "第一条内容");
    assert(sendB?.body?.content === "第二条短句", "第二条内容(--- 已剥离)");

    console.log("\n[12] 引用消息(message_type=103)理解");
    const sendsBefore12 = received.sends.length;
    const quoteEvent = JSON.stringify({
      id: "evt10",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG13",
        content: "哈哈哈哈笑死",
        message_type: 103,
        group_openid: G(5),
        author: { username: "群友戊", bot: false },
        msg_elements: [{ message_type: 103, content: "今天上班好累", author: { username: "群友己" } }],
      },
    });
    await postWebhook(quoteEvent, { signature: signHex(ts + quoteEvent, SECRET), timestamp: ts });
    assert(
      await waitFor(() => received.sends.length >= sendsBefore12 + 1, 15000, "引用消息回复"),
      "引用 @ 消息得到回复",
    );
    const quoteAnswer = answers()[answers().length - 1]?.body;
    assert(
      quoteAnswer?.messages?.some(
        (m) =>
          typeof m.content === "string" &&
          m.content.includes("[引用消息:群友己: 今天上班好累]"),
      ),
      "被引用内容已注入请求",
    );
    console.log("\n[13] 自然语言检索历史(跨请求)");
    const sendsBefore13 = received.sends.length;
    const recallEvent = JSON.stringify({
      id: "evt11",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG14",
        content: "查一下之前的记录 摸鱼",
        group_openid: G(1),
        author: { username: "群友庚", member_openid: "USER9", bot: false },
      },
    });
    await postWebhook(recallEvent, { signature: signHex(ts + recallEvent, SECRET), timestamp: ts });
    assert(
      await waitFor(() => received.sends.length >= sendsBefore13 + 1, 15000, "检索回复"),
      "检索有回复",
    );
    const recallReply = String(received.sends[sendsBefore13]?.body?.content ?? "");
    assert(recallReply.includes("摸鱼"), "检索到此前请求里存下的消息(D1 持久化生效)");
    assert(recallReply.includes("群友甲"), "检索结果带说话人");

    console.log("\n[14] 自然语言总结 + 摘要注入");
    const sendsBefore14 = received.sends.length;
    const summaryEvent = JSON.stringify({
      id: "evt12",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG15",
        content: "总结一下群里最近聊的",
        group_openid: G(1),
        author: { username: "群友庚", member_openid: "USER9" },
      },
    });
    await postWebhook(summaryEvent, { signature: signHex(ts + summaryEvent, SECRET), timestamp: ts });
    assert(
      await waitFor(() => received.sends.length >= sendsBefore14 + 1, 20000, "总结回复"),
      "总结有回复",
    );
    assert(
      String(received.sends[sendsBefore14]?.body?.content ?? "").includes("群友甲"),
      "摘要来自 LLM 并落库",
    );

    const sendsBefore14b = received.sends.length;
    const afterSummaryEvent = JSON.stringify({
      id: "evt13",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG16",
        content: "你们最近都聊啥了",
        group_openid: G(1),
        author: { username: "群友庚", member_openid: "USER9" },
      },
    });
    await postWebhook(afterSummaryEvent, {
      signature: signHex(ts + afterSummaryEvent, SECRET),
      timestamp: ts,
    });
    assert(
      await waitFor(() => received.sends.length >= sendsBefore14b + 1, 20000, "摘要后回复"),
      "摘要后仍能正常回复",
    );
    const summaryInjected = answers()[answers().length - 1]?.body;
    assert(
      summaryInjected?.messages?.some(
        (m) => typeof m.content === "string" && m.content.includes("群聊长期记忆摘要"),
      ),
      "长期摘要已注入上下文",
    );

    console.log("\n[15] 成员画像:发言满额自动生成 + 自然语言查询");
    const portraitTrigger = JSON.stringify({
      id: "evt15",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG18",
        content: "今天又摸了一天鱼",
        group_openid: G(1),
        author: { username: "群友甲", member_openid: "USER8", bot: false },
      },
    });
    await postWebhook(portraitTrigger, {
      signature: signHex(ts + portraitTrigger, SECRET),
      timestamp: ts,
    });
    assert(
      await waitFor(
        () => received.llm.some((c) => isPortrait(c) && JSON.stringify(c.body).includes("群友甲")),
        20000,
        "画像任务",
      ),
      "发言满额触发画像生成",
    );

    const sendsBefore15 = received.sends.length;
    const profileEvent = JSON.stringify({
      id: "evt16",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG17",
        content: "群友甲是什么样的人",
        group_openid: G(1),
        author: { username: "群友庚", member_openid: "USER9" },
      },
    });
    await postWebhook(profileEvent, { signature: signHex(ts + profileEvent, SECRET), timestamp: ts });
    assert(
      await waitFor(() => received.sends.length >= sendsBefore15 + 1, 15000, "画像回复"),
      "画像查询有回复",
    );
    const profileReply = String(received.sends[sendsBefore15]?.body?.content ?? "");
    assert(profileReply.includes("句子短"), "画像内容来自 LLM 并落库");
    assert(/说过 \d+ 句/.test(profileReply), "画像附带发言统计");

    console.log("\n[16] 群风格写进聊天上下文");
    assert(
      await waitFor(() => received.llm.some(isStyle), 20000, "群风格任务"),
      "消息满额触发生成群风格",
    );
    const sendsBefore16 = received.sends.length;
    const styleProbe = JSON.stringify({
      id: "evt17",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG19",
        content: "在吗",
        group_openid: G(1),
        author: { username: "群友庚", member_openid: "USER9" },
      },
    });
    await postWebhook(styleProbe, { signature: signHex(ts + styleProbe, SECRET), timestamp: ts });
    assert(
      await waitFor(() => received.sends.length >= sendsBefore16 + 1, 20000, "风格后回复"),
      "生成风格后仍能正常回复",
    );
    const styleInjected = answers()[answers().length - 1]?.body;
    assert(
      styleInjected?.messages?.some(
        (m) => typeof m.content === "string" && m.content.includes("本群说话风格"),
      ),
      "群风格已注入上下文",
    );

    console.log("\n[17] 冷场主动发言(cron)");
    const sendsBefore17 = received.sends.length;
    const tickRes = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/__scheduled?cron=${encodeURIComponent("* * * * *")}`,
    );
    assert(tickRes.ok, "/__scheduled 可触发(--test-scheduled 生效)");
    assert(
      await waitFor(
        () => received.sends.slice(sendsBefore17).some((s) => s.body?.msg_id === undefined),
        30000,
        "主动发言",
      ),
      "静默到点后主动发消息(不带 msg_id)",
    );
    await sleep(3000); // 等本轮 tick 把 IDLE_BATCH 个群都处理完

    console.log("\n[18] 管理员要求重做画像");
    const sendsBefore18 = received.sends.length;
    const reprofileEvent = JSON.stringify({
      id: "evt18",
      op: 0,
      t: "GROUP_AT_MESSAGE_CREATE",
      d: {
        id: "MSG20",
        content: "重新给群友甲做个画像",
        group_openid: G(1),
        author: { username: "群主", member_openid: "ADMIN1" },
      },
    });
    await postWebhook(reprofileEvent, {
      signature: signHex(ts + reprofileEvent, SECRET),
      timestamp: ts,
    });
    assert(
      await waitFor(
        () => received.sends.some((s) => s.body?.msg_id === "MSG20"),
        20000,
        "重做画像回复",
      ),
      "重做画像有回复",
    );
    const reprofileReply = String(
      received.sends.find((s) => s.body?.msg_id === "MSG20")?.body?.content ?? "",
    );
    assert(
      reprofileReply.includes("重新看了一遍"),
      `重做画像直接返回新结果(实际:${reprofileReply.slice(0, 60)})`,
    );
    assert(received.sends.length >= sendsBefore18 + 1, "重做画像写入发送队列");
  } finally {
    restoreVars(); // 先恢复真实 .dev.vars,再做有风险的进程清理
    await cleanup();
  }

  console.log(failures === 0 ? "\n[smoke] ALL PASS" : `\n[smoke] ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[smoke] crashed:", err);
  process.exit(1);
});
