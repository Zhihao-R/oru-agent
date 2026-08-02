/**
 * runRecallPicker 单测 —— 廉价召回挑选器（recall tech-design §1.2 / §1.5 / §1.6）
 *
 * 复用 runOneShot 范式：systemContext = [指令 + 候选简介块]（稳定前缀），prompt = [洗过的对话窗口]。
 * 只回 id（不回内容）；selected 固定上限、高精度门槛（确定相关才选）；幻觉 / 越界 id 一律过滤掉。
 */
import { describe, expect, it } from 'vitest';
import type { AgentBackend, OneShotResult } from '@shared/agent/backend';
import type { RecallTurn } from '@shared/memory/recall';
import type { EpisodeBrief } from '../../electron/main/memory/recall/briefs';
import {
  buildPickerPrompt,
  buildPickerSystemContext,
  parsePickerOutput,
  runRecallPicker,
  SELECTED_LIMIT,
} from '../../electron/main/memory/recall/picker';

const BRIEFS: EpisodeBrief[] = [
  { id: 'a/banjia', line: 'a/banjia [user·2026-06-01] 搬家方案 - 聊了换房', title: '搬家方案' },
  { id: 'a/fitness', line: 'a/fitness [user·2026-05-01] 健身计划 - 每周三练', title: '健身计划' },
];

function mockBackend(text: string): Pick<AgentBackend, 'runOneShot' | 'backendType'> {
  return {
    backendType: 'anthropic',
    runOneShot: async (): Promise<OneShotResult> => ({ text }),
  };
}

describe('buildPickerSystemContext / buildPickerPrompt', () => {
  it('systemContext = 指令（含高精度门槛）+ 候选简介块逐行', () => {
    const sys = buildPickerSystemContext(BRIEFS);
    expect(sys).toMatch(/确定相关/); // 高精度门槛
    expect(sys).toContain('a/banjia [user·2026-06-01] 搬家方案 - 聊了换房');
    expect(sys).toContain('a/fitness [user·2026-05-01] 健身计划 - 每周三练');
  });

  it('prompt = 洗过的对话窗口（用户 / Oru 行）', () => {
    const win: RecallTurn[] = [
      { role: 'user', text: '我们上次聊的搬家' },
      { role: 'assistant', text: '让我想想' },
    ];
    const p = buildPickerPrompt(win);
    expect(p).toContain('用户：我们上次聊的搬家');
    expect(p).toContain('Oru：让我想想');
  });
});

describe('parsePickerOutput', () => {
  const valid = new Set(['a/banjia', 'a/fitness']);

  it('解析 selected + hints，过滤越界/幻觉 id', () => {
    const out = parsePickerOutput(
      JSON.stringify({ selected: ['a/banjia', 'a/hallucinated'], hints: ['a/fitness'] }),
      valid,
    );
    expect(out.selected).toEqual(['a/banjia']); // 幻觉 id 被剔
    expect(out.hints).toEqual(['a/fitness']);
  });

  it('容忍 ```json 围栏', () => {
    const out = parsePickerOutput('```json\n{"selected":["a/banjia"],"hints":[]}\n```', valid);
    expect(out.selected).toEqual(['a/banjia']);
  });

  it('selected 去重并截到上限', () => {
    const many = Array.from({ length: SELECTED_LIMIT + 3 }, (_, i) => `id${i}`);
    const v = new Set(many);
    const out = parsePickerOutput(JSON.stringify({ selected: [...many, 'id0'], hints: [] }), v);
    expect(out.selected.length).toBe(SELECTED_LIMIT);
    expect(new Set(out.selected).size).toBe(out.selected.length); // 无重复
  });

  it('坏 JSON → 空选（宁缺毋滥）', () => {
    expect(parsePickerOutput('不是 json', valid)).toEqual({ selected: [], hints: [] });
  });

  it('hints 不与 selected 重复', () => {
    const out = parsePickerOutput(
      JSON.stringify({ selected: ['a/banjia'], hints: ['a/banjia', 'a/fitness'] }),
      valid,
    );
    expect(out.hints).toEqual(['a/fitness']);
  });
});

describe('runRecallPicker', () => {
  it('候选为空 → 直接空选，不调模型', async () => {
    let called = false;
    const backend: Pick<AgentBackend, 'runOneShot' | 'backendType'> = {
      backendType: 'anthropic',
      runOneShot: async () => {
        called = true;
        return { text: '{}' };
      },
    };
    const out = await runRecallPicker([], [{ role: 'user', text: 'x' }], { backend });
    expect(out).toEqual({ selected: [], hints: [] });
    expect(called).toBe(false);
  });

  it('挑选器回选中 id → 解析并按 valid 过滤', async () => {
    const backend = mockBackend(JSON.stringify({ selected: ['a/banjia'], hints: ['a/fitness'] }));
    const out = await runRecallPicker(BRIEFS, [{ role: 'user', text: '搬家那事' }], { backend });
    expect(out.selected).toEqual(['a/banjia']);
    expect(out.hints).toEqual(['a/fitness']);
  });

  it('请求 cacheSystem（简介块缓存，PRD §5.4 第二支柱）+ disableReasoning（廉价）', async () => {
    let seen: { cacheSystem?: boolean; disableReasoning?: boolean } | null = null;
    const backend: Pick<AgentBackend, 'runOneShot' | 'backendType'> = {
      backendType: 'anthropic',
      runOneShot: async (input): Promise<OneShotResult> => {
        seen = input;
        return { text: '{"selected":[],"hints":[]}' };
      },
    };
    await runRecallPicker(BRIEFS, [{ role: 'user', text: 'x' }], { backend });
    expect(seen!.cacheSystem).toBe(true);
    expect(seen!.disableReasoning).toBe(true);
  });
});
