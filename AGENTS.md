# Oru 项目约定

这份文件是这个仓库的工程约定，给维护者 / 贡献者参考。核心原则：改动要可验证、可回溯、不引入无法清理的副作用。

## 副作用生命周期

注册监听器 / 定时器 / watcher 必须写对应清理，与注册同处可见：

- 范例：`electron/main/fs/watcher.ts` 的 ProjectWatch——watcher 与 debounce timer 成对收在
  一个结构里，`closeWatcherIn` / `unwatchAll` 双层清理，回调闭包捕获创建时的实例（不读模块全局）。
- AbortSignal 监听：`{ once: true }` + finally 里显式 `removeEventListener` 双保险
  （范例：`render/htmlRenderer.ts` 的 withOffscreenPage）。signal 可能被上游跨调用复用，只靠 once 不够。

## 原子写

文本落盘一律走 `fs/safeWrite.ts`（同步 `safeWrite` / 异步 `safeWriteAsync`，tmp+rename）——
全仓库只有这一套原子写内核，store 的 `writeAtomic` 也代理到它。Buffer（PNG/PDF）或
用完即删的临时文件不强求，原地注释说明即可。

## Proposal 状态流转

status 赋值 + statusChanged 广播只经 `proposals/lifecycle.ts` 的 `transitionProposal`——
非法迁移会 throw。不要在任何地方手写 `proposal.status = ...`。

## 并发：await 后重检共享状态

主进程单线程但处处异步：每个 `await` 都让出过 event loop，期间共享状态（proposal
status、store 缓存、模块级 Map）可能已被别的回调改掉。`await` 回来后不要沿用
await 之前读到的值做判断——承重判断（防抖、终态、是否已处理）必须重读再判。
范例：`ws/router.ts` proposal.execute 在 `await import` 之后重检
`proposal.status !== 'pending'`（并发"同时点确认+拒绝"靠它挡住）。
read-modify-write 整块入锁的既有约定同样源于此。

## 界面文案 i18n（开发时就考虑，别留硬编码中文）

新功能里任何**会上屏给用户看的文字**，写的时候就走 i18n，别硬编码中文等测试兜底——
现有 key-alignment 门槛只管"en 覆盖没覆盖 zh 的已抽键"，**抓不到"该抽却没抽"的裸中文**
（describeFrequency / toolActivity 漏过半年就是因为它们在 `src/` 外的 `@shared/`）。

- **取词**：渲染层 `useTranslation()` 的 `t()`；非 React 处 `import i18n from '@/lib/i18n'` 后
  `i18n.t('ns:key')`；主进程 `i18n/t.ts` 的 `t(key, lang, params)`（按 owner 语言、禁
  `changeLanguage`）。资源放 `locales/{zh,en}/<ns>.json`，新 ns 在 `shared/i18n/resources.ts` 注册。
- **`@shared/` 里被 UI 渲染的 formatter 同样算**（如 `scheduledTasks/describe.ts`）：纯函数不持
  i18n，**接 `t` 译者**——渲染层传 `useTranslation` 的 t、主进程传 `i18n/t.ts` 的 `tFor(lang)`。
  范例：`describeFrequency(spec, runs, t)`。
- **四类边界**（只翻"给人看的话"）：喂 AI 的 prompt / 写盘内容（文件名等）/ 数据哨兵 /
  枚举值（如 BoardTaskStatus 中文值）/ 含协议·jargon 的诊断错误——**都不翻**，原地保留并按需注释说明缘由。
- **称呼**：界面提及 AI 主体一律 Oru / 个体名（`{{name}}` 插值，无名回落 Oru）。
- **英文复数**：可数名词用 i18next `_one/_other`（否则"1 minutes ago"）；UI 渲染的中文界面值改动
  要同步更新 `tests/i18n/<ns>Zh.test.ts` 快照。

## 自我认知知识库同步（改用户能感知能力＝同步改这个库）

新增 / 改动任何**用户能感知的产品能力**（纯内部重构不算），同一批改动里必须同步更新自我认知
知识库 `resources/self-knowledge/capabilities/*.md`——这是该能力"做完"的一部分。它是 Oru 谈论
自己功能时的唯一事实源（随应用发布、按"用户能感知的能力"组织），**过期比缺失更有害**。

- 一条用户能感知的能力一个 `.md`：frontmatter `id/title/area/summary/covers/source` + 正文
  体感 / 限制 / 前提 / 怎么用。`covers` 填实现该能力的**工具名**（纯 UI 无工具锚点留空）；新领域
  加进 `areas.json`（有序数组，确定性排序是硬要求）。
- **机器兜底有限度**：`tests/selfKnowledge/checklist.test.ts`（D）只抓"有工具支撑的能力被整条
  漏写"——查不出 `covers` 填错、body 描述过期、纯 UI 能力漏写。描述准不准只能靠这条纪律 + 抽查，
  别把"测试绿"当"库齐全"。
- 新增工具若属内部原语（非用户能感知能力），登记进 D 测试的 `INTERNAL_PLUMBING` 忽略集并**写一
  行理由**（无理由测试红）——别拿忽略集当逃生舱图省事。

## 测试约定

- mock 必须 `satisfies` 被 mock 的接口类型，禁止裸对象 `as` 蒙混——接口加字段时假绿。
- 测试不得依赖隐性开关的默认值（如 debugLogger 默认关闭）；行为靠显式设置，不靠"恰好没开"。
- 修 bug 必配验证目标问题本身的回归测试（并发 / attacker / regression 场景），不能只跑既有用例。

## 开发规范补充

### 代码开发

- **第一性原则**：任何决策能从根本目标重新推出"为什么这样而不是那样"，不诉诸惯例/默认/上个项目。方案阶段做"为什么不是X？"反问；审代码时发现"好像应该"的直觉要追来源。
- **helper 接口用 Pick\<InnerType\>**：抽 helper 包装已有函数时，参数类型用 `Pick<InnerArgs, ...>` 透传，不手写新 type——inner 接口改了 helper 自动跟。
- **改名前 grep 三种 import 形态**：跨目录 `'../xxx'`、同目录 `'./xxx'`、动态 `import('./xxx')`——sed 常漏后两种。
- **搬代码注意动态 import 深度**：`await import('../x')` 是字符串字面量，typecheck 不解析——目录深度变了漏改，编译全绿运行才炸。
- **Map 顺序不可靠表达"最近"**：`Map.set(key, v)` key 已存在时不移到末尾。要"最近"语义就加显式时间戳排序。
- **工具输出不可信时改 JSON**：vitest 验结果用 `--reporter=json --outputFile` + `node -e` 读 JSON，别信 stdout。

### Git 操作

- **commit message 含特殊字符用 -F**：反引号/`$()`/`*` 等会被 zsh 命令替换或 glob 吞掉。
- **commit 前核当前分支**：长任务期间可能 checkout 到别的分支，提交会静默落到错误分支。
- **amend/reset 前核 HEAD SHA**：对比 HEAD 与自己上次 commit 的 SHA，不等则中间有别人的 commit，停。
- **工作树有未提交改动时逐 hunk add**：stage 前 `git diff --numstat` 核行数，混了就逐 hunk 挑。验收在干净检出做。
- **stash 栈跨 worktree 共享**：`refs/stash` 是全仓共享的。跨 worktree 时用 `stash apply stash@{N}` 显式指定，别裸 `pop`。

### 流程与 Review

- **大任务完成后自动派多 reviewer**：大文档创作/重写、重的完整代码任务 → 自动并行派多个独立 reviewer，汇总去重分级。每个 reviewer prompt 独立可读，要求"只输出高置信度真问题"。
- **UX 决策必须商量，技术细节自决**：用户可感知的方案先对齐再做；内部实现自己决定。判断标准：上线后用户会注意到差异 = UX。
- **plan 不写完整代码**：给文件路径 + 接口/类型 + 关键算法 + 测试用例，让执行阶段自己写实现。
- **主观质量不建自动评分器**：没有客观金标准时，考生即裁判。做好提示/skill/工具 + 给用户可靠自由度，质量裁判是人。
- **无度量标准的测试一律剔除**：每个"对比/实验/验证"项自检：赢的标准是什么、谁来判、数据从哪来。答不全就剔除。
- **收紧兜底前先量化误杀面**：改阈值型防御前扫日志出分位数，和故障态并排看。正常与故障重叠 → 换方向（告知而非截断）。

### 测试与验证

- **smoke 必须验目标问题本身**：改并发/死锁/安全问题，新写一条专门验证该问题的 smoke——老 smoke 全过只是"基线不退"，不能证明新问题被消灭。
- **reviewer 论断先自核再传播**：给出的"X 存不存在/依赖满没满"类论断，承重前提落笔前自己 grep/read 核一遍。

### 审美

- **优雅/克制/系统性**：任何产出（代码/UI/文档/架构）遵循三锚点。优雅=一行说清不分三段、命名不用回头看；克制=不过度抽象、不为假想未来加层、bug fix 只 fix bug；系统性=相同问题相同模式、接口设计让"加第二个实现"零成本。review 也按这三条审。
