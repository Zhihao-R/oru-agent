/**
 * tableGate —— AI 出口闸门（动手前查草稿与编码）。
 *
 * 并发要点：执行前**同步**拉脏集（不读异步推送缓存——"刚改一格立刻让 AI 动手"不能漏）；
 * 超时方向是保守拦截（提示稍后重试），不放行——读路径求可用、闸门路径求安全，方向相反。
 *
 * 出路要点（2026-07-28）：被拦的一方必须拿到一条它自己能走的路，否则它会去找绕行路径
 * （那次事故是 delete 原文件 + write_file 重建，内容缩水）。两支各测各的出路文案。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import {
  rendererQuery,
  resetRendererQueryForTest,
  resolveRendererQuery,
  setRendererQueryDeps,
} from '../../electron/main/agent/rendererQuery';
import { assertTableGate } from '../../electron/main/proposals/tableGate';

let root: string;
let dirtyPaths: string[];
let answerQueries: boolean;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oru-gate-'));
  dirtyPaths = [];
  answerQueries = true;
  resetRendererQueryForTest();
  setRendererQueryDeps({
    broadcast: (e) => {
      // 模拟渲染进程即时应答 dirtySet
      if (e.type === 'renderer.query' && e.kind === 'dirtySet' && answerQueries) {
        resolveRendererQuery(e.queryId, { paths: dirtyPaths });
      }
    },
    hasClients: () => true,
  });
  void rendererQuery; // 仅为类型引用
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('assertTableGate（脏文件）', () => {
  it('提案文本含脏文件名（相对路径形态）→ 拦截，出路是让 AI 转告用户去保存', async () => {
    dirtyPaths = ['data/销售.csv'];
    // agent 按不了 ⌘S，唯一能执行的动作就是把这件事说给用户听——文案必须写成那个动作
    await expect(
      assertTableGate(['python3 汇总.py 销售.csv'], { cwd: root, timeoutMs: 200 }),
    ).rejects.toThrow(/告诉用户|tell the user/);
  });

  it('提案文本与脏文件无关 → 放行', async () => {
    dirtyPaths = ['data/别的.csv'];
    await expect(assertTableGate(['ls -la'], { cwd: root, timeoutMs: 200 })).resolves.toBeUndefined();
  });

  it('裸文件名子串不误拦：「报表.csv」的草稿不拦「月报表.csv」的操作（边界回归）', async () => {
    dirtyPaths = ['报表.csv'];
    await expect(
      assertTableGate(['python3 p.py 月报表.csv'], { cwd: root, timeoutMs: 200 }),
    ).resolves.toBeUndefined();
    await expect(
      assertTableGate(['python3 p.py 报表.csv'], { cwd: root, timeoutMs: 200 }),
    ).rejects.toThrow(/未保存|unsaved/);
  });

  it('只读命令同样过草稿检查：读到的磁盘版正是过期的那版', async () => {
    dirtyPaths = ['表.csv'];
    await expect(
      assertTableGate(['cat 表.csv'], { cwd: root, timeoutMs: 200, skipEncodingCheck: true }),
    ).rejects.toThrow(/未保存|unsaved/);
  });

  it('编辑器无应答（超时）→ 降级按无脏放行（方案 B：不再保守拦截）', async () => {
    answerQueries = false;
    await expect(assertTableGate(['ls'], { cwd: root, timeoutMs: 50 })).resolves.toBeUndefined();
  });

  it('并发场景：置 dirty 后立刻执行提案——同步拉取不漏', async () => {
    dirtyPaths = []; // 初始干净
    dirtyPaths = ['表.csv']; // "刚改一格"——同步拉取读到的必须是这次的脏集
    await expect(assertTableGate(['cat 表.csv'], { cwd: root, timeoutMs: 200 })).rejects.toThrow(
      /未保存|unsaved/,
    );
  });
});

describe('assertTableGate（编码）', () => {
  it('引用的 CSV 是 GBK → 拦截，出路是 convert_csv_encoding，文件不被触碰', async () => {
    const gbk = iconv.encode('名,值\n张三,1\n', 'gbk');
    writeFileSync(join(root, '旧表.csv'), gbk);
    const err = await assertTableGate(['python3 process.py 旧表.csv'], { cwd: root, timeoutMs: 200 }).catch(
      (e: Error) => e,
    );
    expect(err.message).toMatch(/不是 UTF-8|not UTF-8/); // 文案按 owner 语言取词，双语都认
    // 出路必须是 agent 自己能调的工具，不能是"去弹窗里点某个按钮"（那正是 2026-07-26 绕行的病根）
    expect(err.message).toMatch(/convert_csv_encoding/);
    expect(iconv.decode(readFileSync(join(root, '旧表.csv')), 'gbk')).toBe('名,值\n张三,1\n');
  });

  it('规范 CSV / 不存在的 CSV（脚本的新输出）→ 放行', async () => {
    writeFileSync(join(root, '好表.csv'), '名,值\n张三,1\n');
    await expect(
      assertTableGate(['python3 p.py 好表.csv 新输出.csv'], { cwd: root, timeoutMs: 200 }),
    ).resolves.toBeUndefined();
  });

  // 闸门判据 = 编码安全，不是风格规范。风格差异重写无损、用户无可判之处，拦它只会把 AI
  // 锁在自己刚写的文件外（回归：AI 给不含逗号的长文本裹了引号，此后连 cat 都被拦，
  // 只能删文件重建才能继续）。
  it('风格不规范但编码干净的 CSV（多余引号 / CRLF）→ 放行', async () => {
    writeFileSync(join(root, '多引号.csv'), '名,值\n"全角；标点，无需引号",1\n');
    writeFileSync(join(root, 'crlf.csv'), '名,值\r\n张三,1\r\n');
    await expect(
      assertTableGate(['python3 p.py 多引号.csv crlf.csv'], { cwd: root, timeoutMs: 200 }),
    ).resolves.toBeUndefined();
  });

  // 判据是不可逆性：不消费也不产出内容的动作写不出混合编码文件（只读命令、delete/move/rename）
  it('skipEncodingCheck → GBK 文件也放行（只读命令 / delete / move / rename）', async () => {
    writeFileSync(join(root, '旧表.csv'), iconv.encode('名,值\n张三,1\n', 'gbk'));
    await expect(
      assertTableGate(['cat 旧表.csv'], { cwd: root, timeoutMs: 200, skipEncodingCheck: true }),
    ).resolves.toBeUndefined();
  });
});
