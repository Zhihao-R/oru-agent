/**
 * watcher owner 记账合约测试。
 *
 * 先钉住文件树语义（展开布哨兵 / 级联折叠 / reset 全清 / 切项目全清），再验 owner 记账
 * 新行为：tree 级联不拆 table owner、table 精确清理、error 自毁清账后可重布（attacker 回归：
 * 自毁后记账残留 → watchDir 拒绝重布 → 永久失盲）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Broadcast } from '../../electron/main/ws/server';
import {
  simulateWatcherErrorForTest,
  unwatchAll,
  unwatchDir,
  watchDir,
  watcherOwnersForTest,
} from '../../electron/main/fs/watcher';

let root: string;
const noopBroadcast: Broadcast = () => {};

/** 当前记账快照：relDir → 排序后的 owner 列表；空记账为 {} */
const owners = () => watcherOwnersForTest();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oru-watcher-'));
  mkdirSync(join(root, 'a/b'), { recursive: true });
  mkdirSync(join(root, 'c'), { recursive: true });
});

afterEach(() => {
  unwatchAll();
  rmSync(root, { recursive: true, force: true });
});

describe('文件树语义（钉现状）', () => {
  it('展开布哨兵幂等：同目录重复 watch 只记一份', () => {
    watchDir('p1', root, 'a', 'tree', noopBroadcast);
    watchDir('p1', root, 'a', 'tree', noopBroadcast);
    expect(owners()).toEqual({ a: ['tree'] });
  });

  it('级联折叠：unwatch 父目录连带清掉后代哨兵', () => {
    watchDir('p1', root, '', 'tree', noopBroadcast);
    watchDir('p1', root, 'a', 'tree', noopBroadcast);
    watchDir('p1', root, 'a/b', 'tree', noopBroadcast);
    watchDir('p1', root, 'c', 'tree', noopBroadcast);
    unwatchDir('p1', 'a', 'tree');
    expect(owners()).toEqual({ '': ['tree'], c: ['tree'] });
  });

  it("reset：unwatchDir('') 全清", () => {
    watchDir('p1', root, '', 'tree', noopBroadcast);
    watchDir('p1', root, 'a', 'tree', noopBroadcast);
    unwatchDir('p1', '', 'tree');
    expect(owners()).toEqual({});
  });

  it('切项目：新 projectId 的 watch 自动清掉旧项目全部哨兵', () => {
    watchDir('p1', root, 'a', 'tree', noopBroadcast);
    watchDir('p2', root, 'c', 'tree', noopBroadcast);
    expect(owners()).toEqual({ c: ['tree'] });
  });

  it('文件变动 → debounce 后 broadcast 文件级 fs.changed（G38：带 filePath + 目录级 path）', async () => {
    const events: unknown[] = [];
    const broadcast: Broadcast = (e) => events.push(e);
    watchDir('p1', root, 'a', 'tree', broadcast);
    let seq = 0;
    await vi.waitFor(
      () => {
        // 每轮轮询都写一次：FSWatcher 在高负载下可能错过布设前的首次写；
        // 轮询间隔须大于 250ms 防抖窗，否则连续写会不断重置计时器永不触发
        writeFileSync(join(root, 'a/new.txt'), `x${seq++}`);
        // 真实 fs.watch 提供 filename → 文件级事件（带 path=a 供目录级消费者、filePath 供编辑器精确命中）
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'fs.changed',
            projectId: 'p1',
            path: 'a',
            filePath: 'a/new.txt',
          }),
        );
      },
      { timeout: 5000, interval: 400 },
    );
  });
});

describe('owner 记账', () => {
  it('tree 级联折叠不拆 table owner 的哨兵', () => {
    watchDir('p1', root, 'a', 'tree', noopBroadcast);
    watchDir('p1', root, 'a/b', 'tree', noopBroadcast);
    watchDir('p1', root, 'a/b', 'table:a/b/x.csv', noopBroadcast);
    unwatchDir('p1', 'a', 'tree');
    expect(owners()).toEqual({ 'a/b': ['table:a/b/x.csv'] });
  });

  it('table owner 精确清理，不级联、不动 tree', () => {
    watchDir('p1', root, 'a', 'tree', noopBroadcast);
    watchDir('p1', root, 'a', 'table:a/x.csv', noopBroadcast);
    watchDir('p1', root, 'a/b', 'table:a/b/y.csv', noopBroadcast);
    unwatchDir('p1', 'a', 'table:a/x.csv');
    expect(owners()).toEqual({ a: ['tree'], 'a/b': ['table:a/b/y.csv'] });
  });

  it('error 自毁清该 relDir 全部记账，重 watch 成功（attacker 回归：记账残留致永久失盲）', () => {
    const events: unknown[] = [];
    const broadcast: Broadcast = (e) => events.push(e);
    watchDir('p1', root, 'a', 'tree', noopBroadcast);
    watchDir('p1', root, 'a', 'table:a/x.csv', noopBroadcast);
    simulateWatcherErrorForTest('a');
    expect(owners()).toEqual({});
    watchDir('p1', root, 'a', 'tree', broadcast);
    expect(owners()).toEqual({ a: ['tree'] });
  });

  it('unwatchAll 清账后可重布', () => {
    watchDir('p1', root, 'a', 'table:a/x.csv', noopBroadcast);
    unwatchAll();
    expect(owners()).toEqual({});
    watchDir('p1', root, 'a', 'tree', noopBroadcast);
    expect(owners()).toEqual({ a: ['tree'] });
  });
});
