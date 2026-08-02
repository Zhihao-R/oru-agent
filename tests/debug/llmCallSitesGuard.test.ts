/**
 * 调试日志覆盖闸门 —— 防止新增 LLM 调用点静默漏接调试面板。
 *
 * 调试面板的价值是「系统里每一次 LLM 调用都看得到」。但插桩是在各调用点手动包
 * instrumentConversation / instrumentOneShot 的（backend 层拿不到 source/userText 等调用语义，
 * 见 instrument.ts 文件头），编译器不会强制。于是用本测试兜底：
 *
 *   扫 electron/main 下所有发起 LLM 调用的文件（backend.runConversation / runOneShot /
 *   runOneShotWithTimeout），文件集合必须与下面的 allowlist 完全一致。
 *
 * 新增一个 LLM 调用点 → 本测试失败。这是有意的：加调用点时请先用
 * instrumentConversation / instrumentOneShot 接进调试日志，再把文件登记到对应 allowlist。
 * 确有理由不接（如 Promptbench 这种本身就是调试入口的），也登记并写明原因。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const SCAN_DIR = join(ROOT, 'electron/main');

/** 允许直接调用 LLM 入口的文件（仓库根相对路径）→ 每个都已接调试日志，或注明有意不接 */
const ALLOWLIST = new Set<string>([
  // A 类 runConversation —— instrumentConversation 包事件流
  'electron/main/agent/runner.ts', // 主对话（runner.ts 内手写插桩）
  'electron/main/agent/subagentChat/runner.ts', // 对话期 subagent
  'electron/main/tasks/subagentRunner.ts', // 任务编码 subagent
  'electron/main/memory/dream.ts', // 记忆复盘
  'electron/main/scheduledTasks/executor.ts', // 定时任务后台执行体（instrumentConversation，source='scheduled'）
  'electron/main/agent/twinBackgroundQuery.ts', // 背景 Twin
  // B 类 runOneShot / runOneShotWithTimeout —— instrumentOneShot 包结果
  'electron/main/memory/capture.ts', // 记忆抓取
  'electron/main/search/summarizer.ts', // 网页二次摘要
  'electron/main/agent/autoNameConversation.ts', // 对话自动命名
  'electron/main/agent/context/compress.ts', // 上下文压缩
  'electron/main/agent/backends/runOneShotWithTimeout.ts', // 通用超时包装（infra，透传 instrument 上游）
  'electron/main/agent/backends/meterBackend.ts', // 用量计量代理（S13 infra，透明包 target.runConversation/runOneShot；真实 instrument 在 getBackendFor 各调用方）
  'electron/main/ws/aside/comment.ts', // 随手评点 one-shot 短评（instrumentOneShot，source='aside_comment'）
  'electron/main/loop/reviewer.ts', // Loop 独立审查员 one-shot（instrumentOneShot，source='loop_reviewer'）
  'electron/main/loop/compileChecklist.ts', // Loop checklist 编译 one-shot（instrumentOneShot，source='loop_compile'）
  'electron/main/memory/recall/picker.ts', // 召回挑选器 one-shot（instrumentOneShot，source='memory_recall'）
  // 有意不接：Promptbench 是开发者 Prompt 工作台，本身就是调试入口，接调试日志属循环。
  // promptbench.run 已随 D2(a) 迁到 handlers/prompts.ts（router.ts 的 legacy switch 已删净，不再调 LLM）。
  'electron/main/ws/handlers/prompts.ts',
]);

/**
 * 三种 LLM 调用入口的形态。
 * 前两条带前导点，只匹配方法调用、不匹配 backend 里的 `runConversation(`/`runOneShot(` 方法定义。
 * 第三条是裸函数名，会连 `runOneShotWithTimeout(` 的定义本身一起匹配——无妨：定义文件
 * runOneShotWithTimeout.ts 内部确实调 `.runOneShot`，本就在 allowlist 里。
 */
const CALL_PATTERNS = [/\.runConversation\s*\(/, /\.runOneShot\s*\(/, /\brunOneShotWithTimeout\s*\(/];

/** 去掉注释——避免 instrument.ts / teeAndDerive.ts 文件头的示例代码被误判成真实调用 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkTsFiles(abs));
    else if (ent.isFile() && ent.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

describe('LLM 调用点调试日志覆盖闸门', () => {
  it('所有 LLM 调用点都在 allowlist 里（新增调用点请先接 instrument 再登记）', () => {
    const callers = new Set<string>();
    for (const abs of walkTsFiles(SCAN_DIR)) {
      const code = stripComments(readFileSync(abs, 'utf8'));
      if (CALL_PATTERNS.some((re) => re.test(code))) {
        callers.add(relative(ROOT, abs));
      }
    }

    const unlisted = [...callers].filter((f) => !ALLOWLIST.has(f)).sort();
    const stale = [...ALLOWLIST].filter((f) => !callers.has(f)).sort();

    expect(unlisted, `发现未登记的 LLM 调用点——请用 instrumentConversation/instrumentOneShot 接调试日志后登记：\n${unlisted.join('\n')}`).toEqual([]);
    expect(stale, `allowlist 里这些文件已不再调用 LLM，请清理：\n${stale.join('\n')}`).toEqual([]);
  });
});
