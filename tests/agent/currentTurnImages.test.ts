/**
 * ClaudeCodeBackend 图片提取口径的单元测试，两条通路：
 *
 * - currentTurnImageAttachments：「本轮新上传的图」——只把本轮真正新发的图喂给模型，
 *   续跑（审批后自发起回合，无新用户消息）不重发上一轮旧图。
 * - seedReferentImageAttachments：fresh-run 灌历史时随种子并入的点睛指代卡截图——
 *   卡挂在历史里、永远不是"本轮最后一条 user 消息"，不补就整条丢（回归：点睛短聊
 *   模型看不见截图、顺着指代文字硬聊）。
 *
 * 「有没有新用户消息」以 userMessage 是否为 undefined 判定（续跑传 undefined）；
 * `''` 是「有一条空文本的新消息」（纯图消息），不能折叠成续跑——曾因 `!!userMessage`
 * 真值判断把桌面纯图消息误判续跑、当轮图静默丢弃（回归见下）。
 */
import { describe, it, expect } from 'vitest';
import type { ChatAttachment, ChatMessage } from '@shared/types';
import {
  currentTurnImageAttachments,
  renderSeedPrompt,
  seedReferentImageAttachments,
} from '../../electron/main/agent/backends/claudeCode';

function userMsg(id: string, attachments?: ChatAttachment[]): ChatMessage {
  return {
    id,
    conversationId: 'c1',
    role: 'user',
    text: 'hi',
    toolCalls: [],
    createdAt: 1,
    done: true,
    ...(attachments ? { attachments } : {}),
  };
}

/** 点睛指代卡（kind 'aside-referent' 的 user 消息）——aside.begin / addReferent 落的种子形态 */
function referentMsg(id: string, attachments?: ChatAttachment[]): ChatMessage {
  return { ...userMsg(id, attachments), kind: 'aside-referent' };
}

function assistantMsg(id: string): ChatMessage {
  return { id, conversationId: 'c1', role: 'assistant', text: 'ok', toolCalls: [], createdAt: 2, done: true };
}

const img: ChatAttachment = {
  kind: 'image',
  relPath: 'attachments/a.png',
  mediaType: 'image/png',
  bytes: 10,
  filename: 'a.png',
};

describe('currentTurnImageAttachments', () => {
  it('本轮有新消息 + 末条 user 带图 → 返回该图', () => {
    const out = currentTurnImageAttachments([userMsg('u1', [img])], 'hi');
    expect(out).toHaveLength(1);
    expect(out[0].filename).toBe('a.png');
  });

  it('纯图消息（userMessage 为空串 + 附件）→ 取图（回归：曾被 !! 误判成续跑丢图）', () => {
    const out = currentTurnImageAttachments([userMsg('u1', [img])], '');
    expect(out).toHaveLength(1);
  });

  it('续跑（userMessage 为 undefined）→ 即使末条 user 带图也返回空，不重发旧图', () => {
    const out = currentTurnImageAttachments([userMsg('u1', [img])], undefined);
    expect(out).toEqual([]);
  });

  it('末条 user 无附件 → 空', () => {
    expect(currentTurnImageAttachments([userMsg('u1')], 'hi')).toEqual([]);
  });

  it('history 为空 / undefined → 空', () => {
    expect(currentTurnImageAttachments([], 'hi')).toEqual([]);
    expect(currentTurnImageAttachments(undefined, 'hi')).toEqual([]);
  });

  it('取最后一条 user（跳过其后无 user 的情况）、只挑 image kind', () => {
    const out = currentTurnImageAttachments(
      [userMsg('u1', [img]), assistantMsg('a1'), userMsg('u2', [img, img])],
      'hi',
    );
    expect(out).toHaveLength(2); // 末条 user u2 的两张，不混入 u1
  });
});

describe('seedReferentImageAttachments', () => {
  it('点睛典型首轮：种子指代卡的图被并入（回归：之前整条丢）', () => {
    // history = 指代卡（带截图）→ 短评 → 用户打的字（无附件）
    const out = seedReferentImageAttachments(
      [referentMsg('card', [img]), assistantMsg('comment'), userMsg('typed')],
      'hi',
    );
    expect(out).toHaveLength(1);
    expect(out[0].filename).toBe('a.png');
  });

  it('末条 user 本身是指代卡（addReferent 作首轮）→ 跳过，与当轮通路合并不重不漏', () => {
    const history = [referentMsg('cardA', [img]), assistantMsg('a1'), referentMsg('cardB', [img])];
    const seed = seedReferentImageAttachments(history, 'hi');
    const current = currentTurnImageAttachments(history, 'hi');
    expect(seed).toHaveLength(1); // 只收 cardA
    expect(current).toHaveLength(1); // cardB 归当轮
  });

  it('纯图消息（空串）也算有新消息——末条指代卡归当轮，不重收', () => {
    const history = [referentMsg('cardA', [img]), assistantMsg('a1'), referentMsg('cardB', [img])];
    expect(seedReferentImageAttachments(history, '')).toHaveLength(1);
  });

  it('普通 user 消息的图不收——口径收窄到 aside-referent', () => {
    const out = seedReferentImageAttachments(
      [userMsg('u1', [img]), assistantMsg('a1'), userMsg('typed')],
      'hi',
    );
    expect(out).toEqual([]);
  });

  it('无新用户消息（续跑形态灌历史）→ 末条指代卡也收，不漏', () => {
    const out = seedReferentImageAttachments([referentMsg('card', [img])], undefined);
    expect(out).toHaveLength(1);
  });

  it('空历史 → 空', () => {
    expect(seedReferentImageAttachments([], 'hi')).toEqual([]);
  });
});

// 回归（真实会话 cnv_TymI7oJum2）：用户贴了两张岗位截图 → 空回合 → 打"继续"（无附件）→
// 切后端触发 fresh-run 重灌历史，模型答"这两张截图我这边看不到内容（当前模型不支持视觉）"，
// 而那个回合跑的正是有视觉的 claude-code。历史被拍扁成纯文本，图没有任何通路进上下文。
// 改法是留指针不留内容：占位句改成图在磁盘上的路径，模型要看就 read_file 读回来。
describe('renderSeedPrompt：历史图片的占位句给出可读回的路径', () => {
  it('历史里的老图 → 占位句给绝对路径，不再说"当前模型不支持视觉"', () => {
    const history = [userMsg('u1', [img]), assistantMsg('a1'), userMsg('u2')];
    const seed = renderSeedPrompt(history, '继续', 'agt_1');
    expect(seed).toContain('read_file');
    expect(seed).toContain('a.png');
    expect(seed).toContain('agt_1'); // 路径按 agent 分目录，锚在原文那一行
    expect(seed).not.toContain('当前模型不支持视觉');
  });

  it('已随本轮 prompt 附上的图 → 仍说"已附上"，不改成指路（图就在模型眼前）', () => {
    const history = [userMsg('u1', [img]), assistantMsg('a1'), userMsg('u2')];
    const seed = renderSeedPrompt(history, '继续', 'agt_1', undefined, new Set([img.relPath]));
    expect(seed).toContain('已随本条消息一并附上');
    expect(seed).not.toContain('read_file');
  });
});
