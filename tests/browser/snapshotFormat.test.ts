/**
 * a11y 快照格式化（S33 浏览器操控 · §6）——纯函数层。
 *
 * 验六件承重事：
 *  1. AX 树压成带 uid 的层级文本：role + name + uid，uid ↔ backendDOMNodeId 映射可查。
 *  2. 操作承重的状态字段跟着走：输入框 value、checked/disabled/expanded 等——没有它们
 *     模型只能盲试错（比价要知道勾没勾、填完要能读回验证）。
 *  3. 剪枝：ignored / 装饰节点（InlineTextBox）不出现，无名 generic 容器折叠（子节点上提），
 *     与父同名的 StaticText 叶子折叠（<button>提交</button> 不占两行）。
 *  4. 封顶（防上下文溢出的承重闸）：超行数 / 字节上限截断并置 truncated。
 *  5. offset 续读：截断的部分不是永久不可达——快照是整文档树、与滚动无关，续读靠 offset 分页
 *    （对齐 read_file 的 offset 范式；「滚动后再快照」拿不到树的后半段）。
 *  6. 名字里的换行被压平——输出保持一行一节点，uid 行不被撕开。
 */
import { describe, expect, it } from 'vitest';
import { formatAxTree, type AXNode } from '../../electron/main/browser/snapshotFormat';

/** 造节点的小工具：默认可见、有 backendDOMNodeId */
function node(partial: Partial<AXNode> & { nodeId: string }): AXNode {
  return {
    ignored: false,
    role: { value: 'generic' },
    name: { value: '' },
    ...partial,
  };
}

describe('层级文本与 uid 映射', () => {
  it('role + name 逐层缩进，交互节点带 uid，映射回 backendDOMNodeId', () => {
    const nodes: AXNode[] = [
      node({
        nodeId: '1',
        role: { value: 'RootWebArea' },
        name: { value: 'Example Page' },
        backendDOMNodeId: 10,
        childIds: ['2', '3'],
      }),
      node({
        nodeId: '2',
        parentId: '1',
        role: { value: 'heading' },
        name: { value: 'Hello' },
        backendDOMNodeId: 20,
      }),
      node({
        nodeId: '3',
        parentId: '1',
        role: { value: 'link' },
        name: { value: 'More' },
        backendDOMNodeId: 30,
      }),
    ];
    const r = formatAxTree(nodes);
    const lines = r.text.split('\n');
    expect(lines[0]).toMatch(/^- RootWebArea "Example Page" \[uid=\d+\]$/);
    expect(lines[1]).toMatch(/^  - heading "Hello" \[uid=\d+\]$/);
    expect(lines[2]).toMatch(/^  - link "More" \[uid=\d+\]$/);
    // uid → backendDOMNodeId 映射：link 那行的 uid 应指回 30
    const linkUid = Number(/\[uid=(\d+)\]/.exec(lines[2])![1]);
    expect(r.uidToBackendNodeId.get(linkUid)).toBe(30);
    expect(r.truncated).toBe(false);
  });

  it('无 backendDOMNodeId 的节点不带 uid（无从操作，不给假引用）', () => {
    const nodes: AXNode[] = [
      node({
        nodeId: '1',
        role: { value: 'RootWebArea' },
        name: { value: 'p' },
        childIds: ['2'],
      }),
      node({ nodeId: '2', parentId: '1', role: { value: 'StaticText' }, name: { value: 'hi' } }),
    ];
    const r = formatAxTree(nodes);
    expect(r.text).toContain('- StaticText "hi"');
    expect(r.text).not.toContain('uid=');
    expect(r.uidToBackendNodeId.size).toBe(0);
  });

  it('名字含换行被压平成空格，一行一节点', () => {
    const nodes: AXNode[] = [
      node({
        nodeId: '1',
        role: { value: 'RootWebArea' },
        childIds: ['2'],
      }),
      node({
        nodeId: '2',
        parentId: '1',
        role: { value: 'link' },
        name: { value: 'line1\nline2' },
        backendDOMNodeId: 20,
      }),
    ];
    const r = formatAxTree(nodes);
    const uidLines = r.text.split('\n').filter((l) => l.includes('uid='));
    expect(uidLines).toHaveLength(1);
    expect(uidLines[0]).toContain('"line1 line2"');
  });
});

describe('操作承重的状态字段', () => {
  it('输入框带 value；checked/disabled 等非默认状态以括号列出', () => {
    const nodes: AXNode[] = [
      node({ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '3'] }),
      node({
        nodeId: '2',
        parentId: '1',
        role: { value: 'textbox' },
        name: { value: '搜索' },
        value: { value: 'hello' },
        backendDOMNodeId: 20,
      }),
      node({
        nodeId: '3',
        parentId: '1',
        role: { value: 'checkbox' },
        name: { value: '直飞' },
        backendDOMNodeId: 30,
        properties: [
          { name: 'checked', value: { value: 'true' } },
          { name: 'disabled', value: { value: true } },
        ],
      }),
    ];
    const r = formatAxTree(nodes);
    expect(r.text).toContain('- textbox "搜索" value="hello"');
    expect(r.text).toContain('- checkbox "直飞" (checked, disabled)');
  });

  it('默认态（checked=false 等）不输出，不加噪音', () => {
    const nodes: AXNode[] = [
      node({ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] }),
      node({
        nodeId: '2',
        parentId: '1',
        role: { value: 'checkbox' },
        name: { value: '往返' },
        backendDOMNodeId: 20,
        properties: [{ name: 'checked', value: { value: 'false' } }],
      }),
    ];
    const r = formatAxTree(nodes);
    expect(r.text).not.toContain('(');
  });
});

describe('剪枝', () => {
  it('与父同名的 StaticText 叶子折叠（按钮文字不占两行）', () => {
    const nodes: AXNode[] = [
      node({ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] }),
      node({
        nodeId: '2',
        parentId: '1',
        role: { value: 'button' },
        name: { value: '提交' },
        backendDOMNodeId: 20,
        childIds: ['3'],
      }),
      node({ nodeId: '3', parentId: '2', role: { value: 'StaticText' }, name: { value: '提交' }, backendDOMNodeId: 30 }),
    ];
    const r = formatAxTree(nodes);
    expect(r.text.split('\n')).toHaveLength(2); // root + button，StaticText 折叠
    expect(r.text).toContain('- button "提交"');
  });

  it('ignored 节点不出现、其子节点上提；InlineTextBox 整支剪掉', () => {
    const nodes: AXNode[] = [
      node({ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '5'] }),
      // ignored 容器，子节点该上提到它的位置
      node({ nodeId: '2', ignored: true, parentId: '1', childIds: ['3'] }),
      node({
        nodeId: '3',
        parentId: '2',
        role: { value: 'button' },
        name: { value: 'Go' },
        backendDOMNodeId: 30,
        childIds: ['4'],
      }),
      node({ nodeId: '4', parentId: '3', role: { value: 'InlineTextBox' }, name: { value: 'Go' } }),
      node({ nodeId: '5', parentId: '1', role: { value: 'LineBreak' } }),
    ];
    const r = formatAxTree(nodes);
    expect(r.text).toContain('- button "Go"');
    expect(r.text).not.toContain('InlineTextBox');
    expect(r.text).not.toContain('LineBreak');
    // button 上提到 root 直下（缩进一层）
    expect(r.text.split('\n').find((l) => l.includes('button'))).toMatch(/^ {2}- button/);
  });

  it('无名 generic / none 容器折叠：不占一行，子节点上提', () => {
    const nodes: AXNode[] = [
      node({ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] }),
      node({ nodeId: '2', parentId: '1', role: { value: 'generic' }, childIds: ['3'] }),
      node({ nodeId: '3', parentId: '2', role: { value: 'none' }, childIds: ['4'] }),
      node({
        nodeId: '4',
        parentId: '3',
        role: { value: 'link' },
        name: { value: 'Deep' },
        backendDOMNodeId: 40,
      }),
    ];
    const r = formatAxTree(nodes);
    const lines = r.text.split('\n');
    expect(lines).toHaveLength(2); // root + link，两层 generic 折叠掉
    expect(lines[1]).toMatch(/^ {2}- link "Deep"/);
  });

  it('有名字的 generic 保留（有信息量，不折叠）', () => {
    const nodes: AXNode[] = [
      node({ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] }),
      node({
        nodeId: '2',
        parentId: '1',
        role: { value: 'generic' },
        name: { value: 'card' },
        backendDOMNodeId: 20,
      }),
    ];
    const r = formatAxTree(nodes);
    expect(r.text).toContain('- generic "card"');
  });
});

describe('封顶截断与 offset 续读（防上下文溢出的承重闸）', () => {
  const bigTree = (): AXNode[] => {
    const children = Array.from({ length: 50 }, (_, i) => `c${i}`);
    return [
      node({ nodeId: '1', role: { value: 'RootWebArea' }, childIds: children }),
      ...children.map((id, i) =>
        node({
          nodeId: id,
          parentId: '1',
          role: { value: 'link' },
          name: { value: `item ${i}` },
          backendDOMNodeId: 100 + i,
        }),
      ),
    ];
  };

  it('超行数上限截断：置 truncated、报总行数与续读点', () => {
    const r = formatAxTree(bigTree(), { maxLines: 10 });
    expect(r.truncated).toBe(true);
    expect(r.text.split('\n')).toHaveLength(10);
    expect(r.totalLines).toBe(51); // root + 50
    expect(r.nextOffset).toBe(11);
  });

  it('offset 续读拿到后半段（快照与滚动无关，分页是唯一续读通道）', () => {
    const r = formatAxTree(bigTree(), { maxLines: 10, offset: 11 });
    const lines = r.text.split('\n');
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain('item 9'); // 第 11 行 = root 后的第 10 个 link
    expect(r.nextOffset).toBe(21);
    // 末页：不再截断
    const tail = formatAxTree(bigTree(), { maxLines: 10, offset: 51 });
    expect(tail.truncated).toBe(false);
    expect(tail.nextOffset).toBeUndefined();
  });

  it('同一棵树两次窗口的 uid 一致（uid 按全树分配，与窗口无关）', () => {
    const first = formatAxTree(bigTree(), { maxLines: 10 });
    const second = formatAxTree(bigTree(), { maxLines: 10, offset: 11 });
    const uidIn = (r: ReturnType<typeof formatAxTree>, needle: string) =>
      Number(/\[uid=(\d+)\]/.exec(r.text.split('\n').find((l) => l.includes(needle))!)![1]);
    // item 20 只出现在第二窗口；其 uid 映射与全树分配一致
    const uid = uidIn(second, 'item 12');
    expect(second.uidToBackendNodeId.get(uid)).toBe(112);
    expect(first.uidToBackendNodeId.get(uid)).toBe(112);
  });

  it('超字节上限截断并置 truncated；未超限不截', () => {
    const nodes: AXNode[] = [
      node({ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] }),
      node({
        nodeId: '2',
        parentId: '1',
        role: { value: 'paragraph' },
        name: { value: 'x'.repeat(500) },
        backendDOMNodeId: 20,
      }),
    ];
    expect(formatAxTree(nodes, { maxBytes: 100 }).truncated).toBe(true);
    expect(formatAxTree(nodes, { maxBytes: 10_000 }).truncated).toBe(false);
  });
});
