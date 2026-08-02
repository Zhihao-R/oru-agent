import { describe, expect, it } from 'vitest';
import type { ChatRef } from '../../shared/types';
import { buildMessageWithRefs } from '../../src/lib/buildMessageWithRefs';

/**
 * 选段「加入对话」：把 composer 里的引用 chip 渲染成只读上下文块，
 * 拼进最终发给模型的消息（与标注 comment 预填同类）。
 */
function ref(over: Partial<ChatRef> = {}): ChatRef {
  return {
    id: over.id ?? 'r1',
    quote: over.quote ?? '首日留存停在 34%',
    sourcePath: over.sourcePath ?? 'q2-复盘/.narrative.md',
    line: over.line,
  };
}

describe('buildMessageWithRefs', () => {
  it('无 ref 时原样返回 draft', () => {
    expect(buildMessageWithRefs('改一下这页', [])).toBe('改一下这页');
  });

  it('无 ref 且 draft 为空时返回空串', () => {
    expect(buildMessageWithRefs('', [])).toBe('');
  });

  it('单条 ref：上下文块在前、draft 在后，含引文与来源', () => {
    const out = buildMessageWithRefs('帮我改写得更有力', [ref()]);
    // 引文以 markdown 引用块呈现
    expect(out).toContain('> 首日留存停在 34%');
    // 来源标注
    expect(out).toContain('来源: q2-复盘/.narrative.md');
    // draft 原文保留
    expect(out).toContain('帮我改写得更有力');
    // 块在 draft 之前
    expect(out.indexOf('首日留存停在 34%')).toBeLessThan(out.indexOf('帮我改写得更有力'));
  });

  it('带行号时来源附行号', () => {
    const out = buildMessageWithRefs('', [ref({ line: 12 })]);
    expect(out).toContain('来源: q2-复盘/.narrative.md:12');
  });

  it('多行引文逐行加引用前缀', () => {
    const out = buildMessageWithRefs('', [ref({ quote: '第一行\n第二行' })]);
    expect(out).toContain('> 第一行');
    expect(out).toContain('> 第二行');
  });

  it('多条 ref：各成块，按顺序，draft 仍在最后', () => {
    const out = buildMessageWithRefs('综合这两段改', [
      ref({ id: 'a', quote: '引文甲', sourcePath: 'a.md', line: 1 }),
      ref({ id: 'b', quote: '引文乙', sourcePath: 'b.md', line: 9 }),
    ]);
    expect(out).toContain('> 引文甲');
    expect(out).toContain('来源: a.md:1');
    expect(out).toContain('> 引文乙');
    expect(out).toContain('来源: b.md:9');
    expect(out.indexOf('引文甲')).toBeLessThan(out.indexOf('引文乙'));
    expect(out.indexOf('引文乙')).toBeLessThan(out.indexOf('综合这两段改'));
  });

  it('draft 前后有字：上下文块与 draft 间有空行分隔，draft 内容完整', () => {
    const out = buildMessageWithRefs('前后都有字的草稿', [ref()]);
    expect(out.endsWith('前后都有字的草稿')).toBe(true);
    expect(out).toMatch(/\n\n前后都有字的草稿$/);
  });

  it('draft 为空但有 ref：只返回上下文块、结尾无多余空行', () => {
    const out = buildMessageWithRefs('', [ref()]);
    expect(out).toContain('> 首日留存停在 34%');
    expect(out).not.toMatch(/\n\n$/);
  });
});

/**
 * 整文件引用（文件引用进对话 §2）：kind='file' 时渲染成「引用文件: path」让 agent 自己去读，
 * 不渲染 blockquote、不内联全文（决策二）。选段引用（kind 缺省 / 'quote'）形态不变（无回归）。
 */
describe('buildMessageWithRefs — kind=file 整文件引用', () => {
  it('kind=file → 渲染「引用文件: path」，不带 blockquote', () => {
    const out = buildMessageWithRefs('帮我总结这个', [
      { id: 'f1', kind: 'file', quote: '某复盘.md', sourcePath: 'reports/某复盘.md' },
    ]);
    expect(out).toContain('引用文件: reports/某复盘.md');
    expect(out).not.toContain('>'); // 整文件无 blockquote
    expect(out.indexOf('引用文件')).toBeLessThan(out.indexOf('帮我总结这个'));
  });

  it('kind 缺省仍走选段 blockquote 形态（无回归）', () => {
    const out = buildMessageWithRefs('', [ref({ quote: '原文片段' })]);
    expect(out).toContain('> 原文片段');
    expect(out).toContain('来源: q2-复盘/.narrative.md');
    expect(out).not.toContain('引用文件:');
  });

  it('file 引用与 quote 引用混排：各按各的形态渲染', () => {
    const out = buildMessageWithRefs('看这两个', [
      ref({ id: 'q', quote: '选中的话', sourcePath: 'a.md' }),
      { id: 'f', kind: 'file', quote: 'b.html', sourcePath: 'site/b.html' },
    ]);
    expect(out).toContain('> 选中的话');
    expect(out).toContain('来源: a.md');
    expect(out).toContain('引用文件: site/b.html');
  });
});
