# 贡献指南

欢迎 issue 和 PR。改动请尽量小、单一目的，并带上验证。

## 开发流程

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

## 提交前自检

```bash
npm run typecheck
npm test
npm run smoke        # 改了 index / qq / llm / search 链路时必跑
```

三个命令都过再提 PR。

## 代码约定

- TypeScript `strict`，不要用 `any` 逃逸（确实需要就写 `unknown` + 收窄）
- 不引入新的运行时依赖，除非确实必要——Worker 体积和冷启动都很敏感
- 上游调用（QQ / LLM / 搜索）一律**失败降级而不是抛到用户脸上**：聊天场景里静默降级优于报错
- 新增纯函数（拆分、解析、格式化）请配单测，参考 `test/` 现有写法

## PR 描述

说明三件事：改了什么、为什么、怎么验证的（贴命令输出即可）。

## 不要提交

- 任何真实密钥、AppID、BotSecret、群号、个人域名
- 真实群友的昵称、头像或聊天记录
- `node_modules`、`.wrangler`、`.dev.vars`、日志文件
