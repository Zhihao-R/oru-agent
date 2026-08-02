# Oru 测试体系

> 更新：2026-07-23
> 设计原则：测稳定层（后端 / 协议 / 状态机 / 纯逻辑），易变层只做"不崩"级护栏，不测 UI 选择器。

## 一、分层与目录

测试目录按子系统组织，与 `electron/`、`src/`、`shared/` 的模块划分对应。截至 2026-07 约 540 个
vitest 文件 + 107 个 smoke 脚本（数字会随功能增长，`npm test` 跑一遍看当前值，别照抄本文）。

三类测试，按"变动频率 × 价值"分工：

- **vitest 单测（主力）**——node 环境，纯函数 / 状态机 / 协议合约 / store 合约。输入确定→断言确定，
  不连真后端、真浏览器。子目录如 `agent/`（backend 与工具）、`ws/`（router 路径）、`stores/`、
  `lib/`（对应 `src/lib/*`）、`taskboard/`、`git/`、`conversations/`、`proposals/`、`fs/` 等。
- **组件护栏（少量）**——jsdom + @testing-library/react（`components/`、`lib/*.test.tsx`）。**不断言 DOM
  结构、不测选择器**（UI 一改就红、维护成本高于价值），只验"组件 mount 不崩"——专防 zustand
  selector 返新对象导致的无限重渲染（`Maximum update depth`）这类历史 bug。
- **smoke（集成）**——`smoke/__smoke_*__.ts`（tsx 跑）与 `smoke/electron/*bootstrap*.mjs`（真 Electron
  跑，capturePage / 离屏渲染只能在这测）。覆盖端到端链路与需要真仓库 / 真 LLM 的路径。

## 二、怎么跑

```bash
npm test              # vitest run（全部单测）
npm run test:watch    # 改代码自动跑
npm run smoke:all     # 全部 smoke（scripts/smokeRunner.ts 枚举）
npm run smoke:one <name>   # 单跑一个 smoke
npm run typecheck     # 前后端两套 tsc（tsconfig.node / tsconfig.web）
npm run lint:conventions   # 约定 lint（scripts/lintConventions.sh，把踩过的坑固化成机器检查）
npm run test:all      # = lint:conventions + typecheck + vitest + smoke:all
```

## 三、隔离策略（**重要**：绝不污染真实 `~/.oru`）

单测三层防线，成对存在（2026-07-10 backup 测试覆盖真实数据事故后加固）：

1. **worker 兜底**——`tests/setup/oruDir.ts`（`setupFiles` 排最先）把 `process.env.ORU_DIR` 兜到
   一次性 tmpdir，任何测试默认不落真实目录。
2. **硬护栏**——`electron/main/runtime/paths.ts`：VITEST 下缺 `ORU_DIR` 直接抛（拒跑，不静默）。
3. **每文件沙箱**——要断言落盘的测试用 `tests/helpers/oruDirSandbox.ts` 的 `sandboxOruDir(label)`
   开独立目录。

**关键陷阱**：`paths.ts` 在**模块加载时**把 `ORU_DIR` 固化成 const。两种范式二选一：
- **动态 import 型**（多数）：业务模块全走测试体内 `await import(...)`，顶层先 `sandboxOruDir()` 设好
  env——见 `tests/conversations/archive.test.ts`、`tests/taskboard/store.test.ts`。
- **静态 import + mock electron**：`vi.mock` 被提升到 import 之上，env 赋值必须走 `vi.hoisted`（factory
  先于 import 执行、**不能** import helper），再用 `assertOruDirIsolated(paths.ORU_DIR)` 兜护栏。

smoke 各自 `import './__smoke_isolate__';` 重定向 ORU_DIR；唯一例外 `smoke:devstart` 故意用真实
`~/.oru` 做启动 sanity check（readonly）。

## 四、测试工厂（tests/helpers/）

mock 必须 `satisfies` 被 mock 的接口类型（裸 `as` 蒙混会在接口加字段时假绿）。公共构造收敛在
`tests/helpers/`，别再手写样板或 `as unknown as`：

- `toolContext.ts` · `makeToolContext(overrides?)`——ToolContext，必填 6 字段有默认。
- `settings.ts` · `makeSettings(overrides?)`——Settings，`satisfies` 收口。
- `broadcast.ts` · `captureBroadcast()`——收集 ServerEvent，带 `types()` / `statuses()` / `ofType()`。
- `oruDirSandbox.ts` · `sandboxOruDir()` / `assertOruDirIsolated()`——见上节。

`lintConventions.sh` 规则 4 会拦 `as unknown as (ToolContext|Settings)`——违规即红，引导走工厂。

## 五、加新测试

| 想测什么 | 加哪 |
|---|---|
| 纯逻辑 / 状态机 / 校验（无 IO） | `tests/<子系统>/*.test.ts`，静态 import 直接调 |
| 要落盘的 store 行为 | 同上 + `sandboxOruDir()` + 测试体内 `await import` |
| ws 协议路径 | `tests/ws/*.test.ts`，`route(msg, reply, captureBroadcast().broadcast)` |
| 端到端 / 真仓库 / 真 LLM | `tests/smoke/__smoke_*__.ts`，第一行 `import './__smoke_isolate__';` |
| 真 Electron（截图 / 渲染） | `tests/smoke/electron/*bootstrap*.mjs` |
| UI 渲染细节 | **不加**。至多加"组件不崩"级护栏，不断言 DOM |

## 六、纪律（机器兜不住的，靠这些约定）

- 修 bug 必配验证目标问题本身的回归测试（并发 / attacker / regression 场景），不能只跑既有用例。
- 测试不得依赖隐性开关默认值（如 debugLogger 默认关）；行为靠显式设置。
- 承重的破坏性逻辑（rollback 的文件归类等）优先抽纯函数进 vitest 穷举分支，smoke 保端到端。
