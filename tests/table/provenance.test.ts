/**
 * provenance —— 来源反查：打开 CSV 时扫同目录脚本头部（前 10 行）的「写出：X.csv」声明，
 * 命中即认产物；多命中如实返回全部（视图显示歧义提醒）。纯读无缓存、不引元数据文件。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanProvenance } from '../../electron/main/table/provenance';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oru-prov-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanProvenance', () => {
  it('py 脚本声明命中：返回脚本名与来源', async () => {
    writeFileSync(
      join(root, '汇总.py'),
      '# 按区域汇总金额\n# 来源：Q2明细.csv\n# 写出：区域汇总.csv\nimport csv\n',
    );
    expect(await scanProvenance(root, '区域汇总.csv')).toEqual([
      { script: '汇总.py', source: 'Q2明细.csv' },
    ]);
  });

  it('js 双斜线注释同样命中；无来源声明时 source 为 null', async () => {
    writeFileSync(join(root, 'gen.js'), '// 写出：out.csv\nconsole.log(1)\n');
    expect(await scanProvenance(root, 'out.csv')).toEqual([{ script: 'gen.js', source: null }]);
  });

  it('声明在第 11 行不命中（只扫前 10 行）', async () => {
    writeFileSync(join(root, 'late.py'), '\n'.repeat(10) + '# 写出：out.csv\n');
    expect(await scanProvenance(root, 'out.csv')).toEqual([]);
  });

  it('多脚本声明同一产物：全部返回（歧义如实显示）', async () => {
    writeFileSync(join(root, 'a.py'), '# 写出：out.csv\n');
    writeFileSync(join(root, 'b.sh'), '# 写出：out.csv\n');
    const hits = await scanProvenance(root, 'out.csv');
    expect(hits.map((h) => h.script).sort()).toEqual(['a.py', 'b.sh']);
  });

  it('声明指向别的文件 / 普通脚本：不命中', async () => {
    writeFileSync(join(root, 'other.py'), '# 写出：别的.csv\n');
    writeFileSync(join(root, 'plain.py'), 'print(1)\n');
    expect(await scanProvenance(root, 'out.csv')).toEqual([]);
  });
});
