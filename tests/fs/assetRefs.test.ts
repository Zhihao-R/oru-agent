import { describe, expect, it } from 'vitest';
import { rewriteAssetRefs } from '../../electron/main/fs/mutate';

/**
 * rewriteAssetRefs —— 改名时把文档内对「自己的 assets」的引用从 <旧名>.assets/ 回写成 <新名>.assets/。
 * 定界锚定（前面是 ( / " / '，后面紧跟 .assets/）：只动真引用，不误伤正文里偶然出现的同名文字。
 */
describe('rewriteAssetRefs', () => {
  it('回写 markdown 图片引用 ![](旧.assets/x) → ![](新.assets/x)', () => {
    const md = '正文\n![图](架构.assets/a.png)\n更多';
    expect(rewriteAssetRefs(md, '架构', '方案')).toBe('正文\n![图](方案.assets/a.png)\n更多');
  });

  it('回写 <img src> 双引号与单引号两种写法', () => {
    const md = `<img src="架构.assets/a.png" width="320">\n<img src='架构.assets/b.png'>`;
    expect(rewriteAssetRefs(md, '架构', '方案')).toBe(
      `<img src="方案.assets/a.png" width="320">\n<img src='方案.assets/b.png'>`,
    );
  });

  it('保留 ./ 前缀写法', () => {
    expect(rewriteAssetRefs('![](./架构.assets/a.png)', '架构', '方案')).toBe(
      '![](./方案.assets/a.png)',
    );
  });

  it('一篇里多处引用全部回写', () => {
    const md = '![](架构.assets/a.png) 和 ![](架构.assets/b.png)';
    expect(rewriteAssetRefs(md, '架构', '方案')).toBe(
      '![](方案.assets/a.png) 和 ![](方案.assets/b.png)',
    );
  });

  it('不误伤正文里偶然的同名文字（无定界符）', () => {
    const md = '我把文件叫做 架构.assets/x 放在桌面';
    expect(rewriteAssetRefs(md, '架构', '方案')).toBe(md); // 不变
  });

  it('不误伤别篇文档的 assets 引用（名字不同）', () => {
    const md = '![](图表.assets/a.png)';
    expect(rewriteAssetRefs(md, '图', '方案')).toBe(md); // 「图」不该匹配「图表.assets」
  });

  it('旧名含正则特殊字符也安全（点/括号）', () => {
    const md = '![](a.b(1).assets/x.png)';
    expect(rewriteAssetRefs(md, 'a.b(1)', '新')).toBe('![](新.assets/x.png)');
  });
});
