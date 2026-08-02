/**
 * S27 作者标广播：fileChangedEvent 透传 author（'user' / 'ai' / 'merged'），树操作/缺省不带。
 * author 是编辑器消费的快速路径提示（承重判据仍是内容比对），供 S28/S29 消费。
 */
import { describe, expect, it } from 'vitest';
import { fileChangedEvent } from '../../electron/main/fs/fsChanged';

describe('fileChangedEvent 作者标透传', () => {
  it('merged 落盘 → author:merged；文件级 filePath 与目录级 path 都带', () => {
    const ev = fileChangedEvent('prj', 'dir/a.md', 'merged');
    expect(ev).toEqual({ type: 'fs.changed', projectId: 'prj', path: 'dir', filePath: 'dir/a.md', author: 'merged' });
  });

  it('用户手动落盘 → author:user；AI 落盘 → author:ai', () => {
    expect(fileChangedEvent('prj', 'a.md', 'user').author).toBe('user');
    expect(fileChangedEvent('prj', 'a.md', 'ai').author).toBe('ai');
  });

  it('缺省（树操作/来源未知）→ author undefined，不误导消费方', () => {
    expect(fileChangedEvent('prj', 'a.md').author).toBeUndefined();
  });
});
