/**
 * 清单层机器检测（子系统 D，techdoc §D.2 / §D.3）——维护纪律的回归测试本身。
 *
 * 它唯一可靠抓到的：某个**有工具支撑的能力被整条漏写**（声明面有这个工具名，但没有任何
 * 条目的 covers 提到它）。抓不到 covers 填错 / body 过期 / 纯 UI 能力（D.1 已诚实划界）。
 *
 *   声明面 = 所有 registerTool 的工具名
 *   已覆盖 = ∪ 各条目 covers
 *   忽略集 = INTERNAL_PLUMBING（内部原语，每项强制带理由——D.3 堵逃生舱）
 *   漏写   = 声明面 − 已覆盖 − 忽略集，断言为空
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { initSelfKnowledge, allCapabilities } from '../../electron/main/selfKnowledge/registry';
import { registerStaticAgentTools } from '../../electron/main/agent/agentTools';
import { registerBuiltinCapabilities } from '../../electron/main/agent/capabilities';
import { listRegisteredToolNames } from '../../electron/main/agent/backends/factory';

/**
 * 内部原语忽略集：非用户能感知的能力，不该有知识库条目。
 *
 * D.3 逃生舱看护：每项**强制带一行理由**（值非空），无理由则下面 reason 断言报红——
 * 让"把新工具名塞进忽略集图省事"有摩擦。忽略集增长在 PR diff 里可见（其 size 也被打印）。
 */
const INTERNAL_PLUMBING: Record<string, string> = {
  commit_changes: '提案执行通过后的落库原语',
  artifact_finalize_submission: 'deck / HTML 批注流的收尾定版原语',
  list_projects: '列项目元数据的只读原语（Oru 自用，非用户操作）',
  get_project_detail: '读单个项目详情的只读原语',
  escalate_to_user: '向用户求决策的原语',
  ask_user_choice: '向用户出选项的原语',
  ask_twin: '后台编码 subagent 向主 agent 提问的协调原语',
  report_progress: '后台编码 subagent 回报进度的协调原语',
  check_subagent_progress: '主对话现查后台编码 task 进度的原语',
  read_background_output: '按编号读后台命令累积输出的原语（bash run_in_background 的配套现查手段，非独立能力）',
  read_file: '通用文件只读原语（能力体现在「读 / 编辑文档」等 UI 层，非独立能力）',
  list_dir: '通用目录列举只读原语',
  grep: '通用内容检索只读原语',
  glob: '通用文件名匹配只读原语',
  write_file: '通用文件落盘原语（落盘手段；能力体现在编辑器 / 协同编辑 UI 层）',
  edit_file: '通用文件改写原语',
  bash: '命令执行原语',
};

let declared: Set<string>;
let covered: Set<string>;

beforeAll(() => {
  initSelfKnowledge();
  registerStaticAgentTools();
  registerBuiltinCapabilities();
  declared = new Set(listRegisteredToolNames());
  covered = new Set(allCapabilities().flatMap((c) => c.covers));
});

describe('清单层机器检测（D）', () => {
  it('忽略集每项强制带理由（堵逃生舱，D.3）', () => {
    for (const [name, reason] of Object.entries(INTERNAL_PLUMBING)) {
      expect(reason.trim().length, `忽略集 ${name} 缺理由`).toBeGreaterThan(0);
    }
    // 当前忽略集大小可见（增长在 PR review 里应被盯）
    console.log(`[selfKnowledge.D] INTERNAL_PLUMBING size = ${Object.keys(INTERNAL_PLUMBING).length}`);
  });

  it('无"有工具支撑却整条漏写"的能力（漏写集为空）', () => {
    const ignore = new Set(Object.keys(INTERNAL_PLUMBING));
    const missing = [...declared].filter((t) => !covered.has(t) && !ignore.has(t));
    expect(missing, `这些工具名既无条目 covers、也不在忽略集——漏写或漏登记：\n${missing.join('\n')}`).toEqual([]);
  });

  it('covers 里的工具名都真实存在于声明面（防写错名）', () => {
    const bad: string[] = [];
    for (const c of allCapabilities()) {
      for (const t of c.covers) {
        if (!declared.has(t)) bad.push(`${c.id} → ${t}`);
      }
    }
    expect(bad, `covers 引用了不存在的工具名：\n${bad.join('\n')}`).toEqual([]);
  });

  it('忽略集与 covers 不重叠（同一工具不该既覆盖又忽略）', () => {
    const overlap = Object.keys(INTERNAL_PLUMBING).filter((t) => covered.has(t));
    expect(overlap, `这些工具既在忽略集又被 covers 覆盖，归属矛盾：\n${overlap.join('\n')}`).toEqual([]);
  });
});
