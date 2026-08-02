/**
 * scriptOutputs —— 从 bash 命令解析脚本文件、读头部「写出：」声明（前 10 行、固定正则）。
 * 覆盖确认卡（目标已存在 → 红框提示）与执行后 mtime 校验都吃这份解析。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { declaredOutputs } from '../../electron/main/table/scriptOutputs';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oru-scriptout-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('declaredOutputs', () => {
  it('解析命令里的脚本路径并读其「写出」声明（相对 cwd 解析为绝对路径）', async () => {
    writeFileSync(join(root, '汇总.py'), '# 来源：明细.csv\n# 写出：区域汇总.csv\nprint(1)\n');
    expect(await declaredOutputs('python3 汇总.py --verbose', root)).toEqual([
      join(root, '区域汇总.csv'),
    ]);
  });

  it('声明在第 11 行不命中；无声明脚本返回空', async () => {
    writeFileSync(join(root, 'late.sh'), '\n'.repeat(10) + '# 写出：out.csv\n');
    writeFileSync(join(root, 'plain.js'), 'console.log(1)\n');
    expect(await declaredOutputs('bash late.sh && node plain.js', root)).toEqual([]);
  });

  it('命令里的脚本文件不存在 → 安静跳过', async () => {
    expect(await declaredOutputs('python3 不存在.py', root)).toEqual([]);
  });

  it('多脚本多声明合并去重', async () => {
    writeFileSync(join(root, 'a.py'), '# 写出：x.csv\n');
    writeFileSync(join(root, 'b.py'), '# 写出：x.csv\n# 写出：y.csv\n');
    const outs = await declaredOutputs('python3 a.py; python3 b.py', root);
    expect(outs.sort()).toEqual([join(root, 'x.csv'), join(root, 'y.csv')]);
  });
});
