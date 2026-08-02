---
name: writing-oru-skills
description: Reference for writing or patching Oru skills. Use when the user asks "把这个流程存下来"
  / 把刚才的工作流记成 skill / 让分身能自动跑某个任务, or when you finish a complex multi-step task
  (5+ tool calls) that the user might want repeated. Also use before calling skill_manage to refresh
  on SKILL.md structure, frontmatter rules, description writing, and the patch unique constraint.
---

# 给 Oru 写 skill 的元指引

调 `skill_manage(action='create', ...)` 前必读。`patch` 前若不记得 unique 约束也回来看一眼。

## 什么时候 create，什么时候 patch

- **create**：跑通一个之前没成型的工作流，未来会重复用（每月报、特定项目 PR review、风格写作等）
- **patch**：已有 skill 内某段过时 / 某 plugin 激活描述触发不准（少改不重写）

不要的情况：
- 一次性任务（用户只说"这次帮我做下"——sk skill 储而不用反成负担）
- 工作流逻辑还没真跑通就提前写（应该跑过、改过、用户认可了再存）
- 用户没说"存下来"且任务也很普通时

## SKILL.md 结构

```markdown
---
name: <kebab-case-name>
description: <第三人称动词起头> <Use when 用户做/说...> <关键词清单>
---

# <Skill 标题>

<一句话总目标>

## <分支 1>
<操作 / 命令>

## <分支 2>
...
```

只 `name` 和 `description` 是必需 frontmatter。

## frontmatter 规则

- `name`：kebab-case，小写 + 数字 + `-`，最多 64 字符，不能含 `claude` / `anthropic`
- `description`：**这是命门**。Claude 决定要不要用 skill 全靠它

## description 怎么写

格式：`[第三人称动词起头] [做什么]. Use when [何时用，列具体场景，宁可多列]. [关键词清单]`

好例子：

```yaml
description: Extracts text and tables from PDF files, fills forms, merges documents.
  Use when working with PDF files, when the user mentions PDFs, forms, or document extraction,
  or when a tool returns content that looks like a PDF binary.
```

烂例子：

- `Helps with documents.` — 没说何时用、没关键词
- `I can help you process Excel files.` — 第一人称会让触发判断混乱
- `Handles stuff related to GitHub.` — 太泛、动词无力

写完自检：穷举了用户的触发说法没？提了关键词没？用第三人称没？

## body 长度

500 行内。超了按"用户任务分支"拆 reference 文件：

```
my-skill/
├── SKILL.md     # 路标 + 路由
└── reference/
    ├── case-a.md
    └── case-b.md
```

引用层级别超过 1 级（SKILL.md → reference/x.md，不要 reference 再链 reference）。

## body 写作

- **祈使句**，少用 ALWAYS / NEVER；解释 why 比死板规则有效
- **术语全文统一**——别在 "API endpoint" / "URL" / "API route" 之间换
- **不写时间敏感的话**——"2025-08 前用旧 API"会过期
- **不解释术语**——假设读者（Claude / 你的未来分身）有基础

## `skill_manage` 工具用法

### create

```
skill_manage({
  action: 'create',
  name: 'writing-monthly-report',
  create: {
    skillMd: '<完整 SKILL.md 文本>',
    scripts: [...]  // 可选
  }
})
```

frontmatter 缺 description 会被工具拒绝（描述是触发关键字段）。

新建后 **当前对话内不可见**——回声防护：避免你刚自创就被自己写的指令影响判断。下次对话才加载。

### patch

```
skill_manage({
  action: 'patch',
  target: 'skill',         // 或 'plugin-manifest'
  name: 'writing-monthly-report',
  patch: { oldString: '...', newString: '...' }
})
```

**unique 约束**：`oldString` 在目标文件中必须**唯一**出现：
- 0 次匹配 → 工具直接 isError，重新 read_skill 看下当前文本
- >1 次匹配 → 工具直接 isError，加更多上下文让 oldString 唯一定位

跟 Edit 工具同款约束——find-and-replace 没有唯一锚点容易默默写错位置。

`target='plugin-manifest'` 时只能改 `.oru-plugin.json` 的 `activationDescription` 字段（让 plugin 触发更准）。

## 反模式清单

- 写超长 description 试图覆盖所有可能场景 → 真正命门是穷举**用户的说法**，而非穷举场景
- 在 SKILL.md 里塞大段背景知识 → 现代 LLM 已经知道，省 token 给具体操作
- `# 描述`、`# 使用说明`、`# 注意事项` 这种空标题 → 直接写内容
- 用伪代码代替真命令 → skill 是给"跑"用的，不是给"看"的
- skill 内嵌 "TODO" / "待完善" → 跑通了再存，否则别存

## 给 Oru 的特别提醒

- Oru 的工具有 `Task` / `commit_changes` / `mcp_install` 等——skill 内可以直接调它们的能力
- Skill 里如果涉及"做代码改动"，应该走 `Task` 工具（mode async）派子 agent 执行，而不是直接 bash 写文件
- Skill 里如果用 plugin 内 MCP，要在 SKILL.md 顶部提示"调用前需先 `activate_plugin('<plugin-id>')`"
