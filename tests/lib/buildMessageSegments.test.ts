import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../shared/types';
import { buildMessageSegments } from '../../src/lib/buildMessageSegments';

/**
 * assistant 消息分段测试
 *
 * 把"拼平的 text + 工具列表"还原成按时序交错的渲染段：
 * 工具调用在 textOffset 处把文本切开，文本段与工具簇交替。
 * 老数据（无 textOffset）回退到"工具置顶 + 整段文本"。
 */
function tool(id: string, textOffset?: number): ToolCall {
  return {
    id,
    name: `tool-${id}`,
    input: {},
    status: 'success',
    startedAt: 0,
    ...(textOffset === undefined ? {} : { textOffset }),
  };
}

describe('buildMessageSegments', () => {
  it('无工具调用——只有一段文本', () => {
    expect(buildMessageSegments('你好世界', [])).toEqual([
      { kind: 'text', text: '你好世界' },
    ]);
  });

  it('空文本且无工具——返回空数组', () => {
    expect(buildMessageSegments('', [])).toEqual([]);
  });

  it('老数据（工具无 textOffset）——回退到工具置顶 + 整段文本', () => {
    const tools = [tool('a'), tool('b')];
    expect(buildMessageSegments('某段回复', tools)).toEqual([
      { kind: 'tools', tools },
      { kind: 'text', text: '某段回复' },
    ]);
  });

  it('文本→工具→文本——按时序切开交错', () => {
    const t = tool('a', 3); // 前 3 个字后调用
    const segs = buildMessageSegments('前段后段', [t]);
    expect(segs).toEqual([
      { kind: 'text', text: '前段后' },
      { kind: 'tools', tools: [t] },
      { kind: 'text', text: '段' },
    ]);
  });

  it('连续多个工具（同 offset）聚成一簇', () => {
    const t1 = tool('a', 2);
    const t2 = tool('b', 2);
    const segs = buildMessageSegments('开头收尾', [t1, t2]);
    expect(segs).toEqual([
      { kind: 'text', text: '开头' },
      { kind: 'tools', tools: [t1, t2] },
      { kind: 'text', text: '收尾' },
    ]);
  });

  it('不同 offset 的工具分成不同簇，中间文本独立成段', () => {
    const t1 = tool('a', 1);
    const t2 = tool('b', 3);
    const segs = buildMessageSegments('ABCDE', [t1, t2]);
    expect(segs).toEqual([
      { kind: 'text', text: 'A' },
      { kind: 'tools', tools: [t1] },
      { kind: 'text', text: 'BC' },
      { kind: 'tools', tools: [t2] },
      { kind: 'text', text: 'DE' },
    ]);
  });

  it('工具在文本最前（offset 0）——首段无空文本块', () => {
    const t = tool('a', 0);
    const segs = buildMessageSegments('全是后文', [t]);
    expect(segs).toEqual([
      { kind: 'tools', tools: [t] },
      { kind: 'text', text: '全是后文' },
    ]);
  });

  it('纯空白的中间段被丢弃，不产生空 markdown 块', () => {
    const t1 = tool('a', 2);
    const t2 = tool('b', 3); // 第 2~3 字之间只有一个换行
    const segs = buildMessageSegments('AB\nCD', [t1, t2]);
    expect(segs).toEqual([
      { kind: 'text', text: 'AB' },
      { kind: 'tools', tools: [t1] },
      { kind: 'tools', tools: [t2] },
      { kind: 'text', text: 'CD' },
    ]);
  });

  it('乱序传入的工具按 offset 稳定排序后再切', () => {
    const t2 = tool('b', 3);
    const t1 = tool('a', 1);
    const segs = buildMessageSegments('ABCDE', [t2, t1]);
    expect(segs).toEqual([
      { kind: 'text', text: 'A' },
      { kind: 'tools', tools: [t1] },
      { kind: 'text', text: 'BC' },
      { kind: 'tools', tools: [t2] },
      { kind: 'text', text: 'DE' },
    ]);
  });
});
