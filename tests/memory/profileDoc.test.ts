/**
 * profileDoc.ts 单测 —— 常驻认知档案「印象 + 自由章节」文档模型
 *
 * 核心不变量（document-model tech-design §1.2 / §7 / §9）：
 *   1. 幂等：renderProfileDoc(parseProfileDoc(x)) 是定点——再 parse→render 逐字节不变。
 *   2. 零丢失：任何 `## ` 章节（连 body）都不被丢；没有「丢弃」分支（直接复现 2026-06-26 压扁事故的反面）。
 *   3. 规范输入 round-trip 逐字节相等。
 */
import { describe, expect, it } from 'vitest';
import { parseProfileDoc, profileDocPreview, renderProfileDoc, type ProfileDoc } from '@shared/memory/profileDoc';

describe('parseProfileDoc 拆 印象 + 章节', () => {
  it('印象 = 第一个 ## 之前的前言；章节按出现顺序', () => {
    const body = '我对你的整体印象。\n\n## 事实\n- 称呼：阮子\n\n## 饮食习惯\n糙米配豆类。\n';
    const doc = parseProfileDoc(body);
    expect(doc.impression).toBe('我对你的整体印象。');
    expect(doc.sections).toEqual([
      { title: '事实', body: '- 称呼：阮子' },
      { title: '饮食习惯', body: '糙米配豆类。' },
    ]);
  });

  it('无前言（首行即 ##）→ 印象为空', () => {
    const doc = parseProfileDoc('## 事实\n- 现居成都\n');
    expect(doc.impression).toBe('');
    expect(doc.sections).toEqual([{ title: '事实', body: '- 现居成都' }]);
  });

  it('仅印象、无任何章节', () => {
    const doc = parseProfileDoc('就是一段速写，没有分节。\n');
    expect(doc.impression).toBe('就是一段速写，没有分节。');
    expect(doc.sections).toEqual([]);
  });

  it('空档案 → 空印象空章节', () => {
    const doc = parseProfileDoc('');
    expect(doc.impression).toBe('');
    expect(doc.sections).toEqual([]);
  });

  it('章节 body 可为多行任意 markdown，原样保留', () => {
    const doc = parseProfileDoc('## 思维方式\n对「为什么」有执念……\n\n- 喜欢推导\n- 拒绝惯例\n');
    expect(doc.sections).toEqual([
      { title: '思维方式', body: '对「为什么」有执念……\n\n- 喜欢推导\n- 拒绝惯例' },
    ]);
  });
});

describe('profileDocPreview 手帐卡片预览', () => {
  const doc = (impression: string, sections: { title: string; body: string }[] = []): ProfileDoc => ({
    impression,
    sections,
  });

  it('印象是散文时直接取其第一段（关于你）', () => {
    const preview = profileDocPreview(doc('我是一个在成都生活的 AI 产品经理，正在开发 Oru。'));
    expect(preview).toBe('我是一个在成都生活的 AI 产品经理，正在开发 Oru。');
  });

  it('印象只有光标题（`# 我是谁`）→ 从第一个章节正文起（复现关于 oru 空白的 bug）', () => {
    const preview = profileDocPreview(
      doc('# 我是谁', [
        { title: '核心', body: '我是 阮子 的数字分身，叫 Oru。是一个长期陪伴的 AI 助手。' },
        { title: '性格', body: '直觉先行逻辑兜底。' },
      ]),
      { minChars: 10 },
    );
    expect(preview).toBe('我是 阮子 的数字分身，叫 Oru。是一个长期陪伴的 AI 助手。');
  });

  it('不足 minChars → 跨章节续接下一节，段间换行分隔（记得分段）', () => {
    const preview = profileDocPreview(
      doc('# 我是谁', [
        { title: '核心', body: '我是 Oru。' },
        { title: '性格', body: '直觉先行逻辑兜底。' },
      ]),
      { minChars: 12 },
    );
    expect(preview).toBe('我是 Oru。\n直觉先行逻辑兜底。');
  });

  it('跳过 `last-updated-by-dream:` 系统哨兵行', () => {
    const preview = profileDocPreview(doc('last-updated-by-dream: 2026-05-17\n\n真正的正文进展在这里。'));
    expect(preview).toBe('真正的正文进展在这里。');
  });

  it('第一段不足 minChars → 续接下一段（段间换行分隔）', () => {
    const preview = profileDocPreview(doc('短。\n\n这是第二段，把预览补到足够长以便通过最少字数门槛。'), { minChars: 12 });
    expect(preview).toBe('短。\n这是第二段，把预览补到足够长以便通过最少字数门槛。');
  });

  it('已满足 minChars 就不再接下一段', () => {
    const preview = profileDocPreview(doc('这一段已经足够长可以单独作为预览显示了。\n\n第二段不该出现。'), { minChars: 12 });
    expect(preview).toBe('这一段已经足够长可以单独作为预览显示了。');
  });

  it('超过 maxChars → 截断加省略号', () => {
    const preview = profileDocPreview(doc('一二三四五六七八九十'), { maxChars: 5 });
    expect(preview).toBe('一二三四五…');
  });

  it('全空（无印象无章节正文）→ 空预览', () => {
    expect(profileDocPreview(doc('# 我是谁'))).toBe('');
    expect(profileDocPreview(doc(''))).toBe('');
  });
});

describe('renderProfileDoc round-trip', () => {
  it('规范文档 parse→render 逐字节相等', () => {
    const canonical =
      '我对你的整体印象。\n\n## 事实\n- 称呼：阮子\n\n## 饮食习惯\n糙米配豆类。\n';
    expect(renderProfileDoc(parseProfileDoc(canonical))).toBe(canonical);
  });

  it('幂等：render∘parse 是定点（再跑一遍不变）', () => {
    const messy = '印象\n\n\n## A\n\n内容 a\n\n\n## B\n内容 b';
    const once = renderProfileDoc(parseProfileDoc(messy));
    const twice = renderProfileDoc(parseProfileDoc(once));
    expect(twice).toBe(once);
  });

  it('零丢失：含 6 个自定义小节，round-trip 后每节标题与 body 都在（复现压扁事故的反面）', () => {
    const titles = ['事实', '饮食习惯', '作息', '思维方式', '产品观', '生活状态'];
    const body =
      '整体印象一段。\n\n' +
      titles.map((t) => `## ${t}\n${t}的内容。`).join('\n\n') +
      '\n';
    const doc = parseProfileDoc(body);
    expect(doc.sections.map((s) => s.title)).toEqual(titles);
    const rendered = renderProfileDoc(doc);
    for (const t of titles) {
      expect(rendered).toContain(`## ${t}`);
      expect(rendered).toContain(`${t}的内容。`);
    }
  });

  it('仅印象 / 空档案也能 round-trip', () => {
    expect(renderProfileDoc(parseProfileDoc('只有印象。\n'))).toBe('只有印象。\n');
    expect(renderProfileDoc({ impression: '', sections: [] })).toBe('');
  });

  it('空 body 章节（只有标题）保留', () => {
    const doc: ProfileDoc = { impression: '', sections: [{ title: '占位', body: '' }] };
    const rendered = renderProfileDoc(doc);
    expect(parseProfileDoc(rendered).sections).toEqual([{ title: '占位', body: '' }]);
  });
});
