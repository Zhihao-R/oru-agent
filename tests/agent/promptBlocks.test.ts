/**
 * buildPromptBlocks 的空文本守卫——纯图消息（promptText 为空）不得产出 `text:''` 块：
 * Anthropic API 拒绝给空文本块打 cache_control 缓存标记，而 Claude Code CLI 会自动给
 * 近端 user 消息文本块打标 → 400 中断整轮（回归：飞书/桌面纯图消息触发）。
 * 口径与 Anthropic 直连路径 historyAdapter 的 `text.trim().length > 0` 对齐。
 */
import { describe, expect, it } from 'vitest';
import type { ChatAttachment } from '@shared/types';
import { buildPromptBlocks } from '../../electron/main/agent/backends/claudeCode';

// relPath 指向不存在的文件：loadImageBlocks 读盘失败会降级为「[图片加载失败：…]」文本块，
// 正好让本测试不依赖真实附件落盘（守卫行为与图块内容无关）。
const brokenImg: ChatAttachment = {
  kind: 'image',
  relPath: 'no-such/dir/x.png',
  mediaType: 'image/png',
  bytes: 10,
  filename: 'x.png',
};

describe('buildPromptBlocks 空文本守卫', () => {
  it('带图无文 → 不追加空文本块', async () => {
    const blocks = await buildPromptBlocks([brokenImg], '', 'agent-x', 'conv-x');
    expect(blocks).toHaveLength(1); // 只有图（此处为加载失败占位），无 text:'' 块
    expect(blocks.some((b) => b.type === 'text' && b.text === '')).toBe(false);
  });

  it('纯空白文本同样不追加（与 historyAdapter trim 口径一致）', async () => {
    const blocks = await buildPromptBlocks([brokenImg], '  \n ', 'agent-x', 'conv-x');
    expect(blocks.some((b) => b.type === 'text' && b.text.trim() === '')).toBe(false);
  });

  it('有文本 → 文本块在图块之后（图在前文在后，与 Anthropic 直连一致）', async () => {
    const blocks = await buildPromptBlocks([brokenImg], '看看这张图', 'agent-x', 'conv-x');
    expect(blocks[blocks.length - 1]).toEqual({ type: 'text', text: '看看这张图' });
  });

  it('无图有文 → 单文本块（既有行为不变）', async () => {
    const blocks = await buildPromptBlocks([], 'hello', 'agent-x', 'conv-x');
    expect(blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });
});
