---
id: control-model-backend
title: 选择 AI 模型与供应商
area: control
summary: 自由挑供应商和模型（含本机 Claude 登录的 Opus/Sonnet/Haiku 档位、以及 GLM/Kimi/MiniMax 的 coding plan 订阅），并给主对话 / 背景查询 / 写代码等功能位各配一个模型
covers: []
source: docs/tech/2026-06-25-subagent-model-open-plan.md
---

你可以自由挑供应商（OpenRouter、Anthropic、智谱、Kimi、OpenAI 或自定义）和具体模型，并给几个功能位（主对话、背景查询、夜间复盘、写代码）各配一个模型。除了第三方模型，本机 Claude 登录（走订阅额度）也能指定具体档位——Opus 4.8 / Sonnet 4.6 / Haiku 4.5；留「默认」则按功能位轻重自动挑（重活 Opus、廉价背景 Haiku）。切换保存即生效，当前对话能续聊。

如果你买了 GLM Coding Plan、Kimi For Coding 或 MiniMax Coding Plan 的订阅，也能在供应商里选对应的一项、贴一个 key，就把订阅额度里的模型分配给任意功能位用（默认端点预填大陆地址，海外用户可改 Base URL 字段）。

**限制**：调用失败时不会自动切换备用模型，会把消息标红让你去设置里改。主界面不显示"当前用的哪个模型"，只在设置里看得到。只有当没有任何可用后端（没配模型、本机也没登录 Claude Code）时，输入框才会禁用并出现「未就绪」提示，指引你去配置——只要有一路后端能用就不拦。coding plan 有厂商侧的额度窗（打满会限流），额度用尽只能等窗口刷新。

**怎么用**：在「设置 ▸ 模型与供应商」里管理供应商、挑模型、给各功能位分配。
