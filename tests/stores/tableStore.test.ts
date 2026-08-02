// @vitest-environment jsdom

/**
 * tableStore 合约测试 —— 实时自动落盘（草稿/冲突机制下线后）+ 多标签按 path 分桶。
 *
 * ws mock 成模拟磁盘（diskFiles: path → content；假哈希 `h:`+content）。覆盖：
 * 实时落盘 / Op 撤销栈作 ⌘Z / 切回刷新 / 找回旧版 / 不规范三选一 / 超限只读 / 多表不串。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { useTableStore } from '@/stores/tableStore';
import { serializeCsv } from '@shared/csv';

const S = () => useTableStore.getState();
const T = (path = PATH) => S().tables[path]!;
const PRJ = 'p1';
const PATH = 'a.csv';
const CSV = '名,值\n张三,1\n李四,2\n';

let diskFiles: Map<string, string>;
let encodingUnsafe: Set<string>; // 模拟 GBK：编码不安全（转换不可逆 → 保存前要弹确认）
let styleUnclean: Set<string>; // 编码安全、只是风格不规范（多余引号 / CRLF）——保存时不该打扰用户
let overLimitPaths: Set<string>;
let prefsFiles: Map<string, import('@shared/protocol').TablePrefs>; // table.open 回执要捎带的偏好
let prefsSets: Req[]; // 收集所有 table.prefs.set 写请求
const hash = (s: string): string => `h:${s}`;

type Req = { type: string; [k: string]: unknown };
function defaultWs(): void {
  requestMock.mockImplementation((req: Req) => {
    const path = req.path as string;
    switch (req.type) {
      case 'table.open': {
        const content = diskFiles.get(path);
        if (content === undefined) return Promise.reject(new Error('not found'));
        if (overLimitPaths.has(path)) {
          return Promise.resolve({
            type: 'table.opened', projectId: req.projectId, path, overLimit: true, content: null,
            previewRows: [['名', '值'], ['预览', '1']], canonical: true, encodingSafe: true, encoding: 'utf-8', mtimeMs: 1, sha256: null, provenance: [], prefs: null,
          });
        }
        return Promise.resolve({
          type: 'table.opened', projectId: req.projectId, path, overLimit: false, content, previewRows: null,
          canonical: !encodingUnsafe.has(path) && !styleUnclean.has(path),
          encodingSafe: !encodingUnsafe.has(path),
          encoding: encodingUnsafe.has(path) ? 'gbk' : 'utf-8',
          mtimeMs: 1, sha256: hash(content), provenance: [], prefs: prefsFiles.get(path) ?? null,
        });
      }
      case 'fs.writeText': {
        const expected = req.expectedDiskSha256 as string | null | undefined;
        const current = diskFiles.get(path);
        if (expected !== undefined) {
          const currentSha = current === undefined ? null : hash(current);
          if (currentSha !== expected) {
            return Promise.resolve({ type: 'fs.text.writeResult', projectId: req.projectId, path, status: 'conflict' });
          }
        }
        diskFiles.set(path, req.content as string);
        return Promise.resolve({
          type: 'fs.text.writeResult', projectId: req.projectId, path, status: 'saved', mtimeMs: 2, sha256: hash(req.content as string),
        });
      }
      case 'fs.textHash': {
        const content = diskFiles.get(path);
        return Promise.resolve({ type: 'fs.text.hash', projectId: req.projectId, path, sha256: content === undefined ? null : hash(content), size: 0, mtimeMs: 1 });
      }
      case 'fileHistory.restore':
        return Promise.resolve({ type: 'fileHistory.restored', projectId: req.projectId, path, content: '名,值\n旧版,9\n' });
      case 'table.prefs.set':
        prefsSets.push(req);
        return Promise.resolve({ type: 'ack' });
      case 'fs.watch':
      case 'fs.history.sample':
        return Promise.resolve({ type: 'ack' });
      default:
        return Promise.reject(new Error('unexpected ' + req.type));
    }
  });
}

function writeTextCalls(): Req[] {
  return requestMock.mock.calls.map((c) => c[0] as Req).filter((r) => r.type === 'fs.writeText');
}

beforeEach(() => {
  vi.useFakeTimers();
  requestMock.mockReset();
  diskFiles = new Map([[PATH, CSV]]);
  encodingUnsafe = new Set();
  styleUnclean = new Set();
  overLimitPaths = new Set();
  prefsFiles = new Map();
  prefsSets = [];
  defaultWs();
  useTableStore.setState({ tables: {} });
});

afterEach(() => {
  for (const p of Object.keys(S().tables)) S().close(p);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('打开 / 实时落盘', () => {
  it('open 载入磁盘模型', async () => {
    await S().open(PRJ, PATH);
    expect(T().headers).toEqual(['名', '值']);
    expect(T().rows).toEqual([['张三', '1'], ['李四', '2']]);
    expect(T().dirty).toBe(false);
  });

  it('编辑后停手 ~0.8s 自动落盘', async () => {
    await S().open(PRJ, PATH);
    S().editCell(PATH, 0, 1, '99');
    expect(T().dirty).toBe(true);
    expect(writeTextCalls()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(800);
    const w = writeTextCalls();
    expect(w).toHaveLength(1);
    expect(w[0].expectedDiskSha256).toBeUndefined(); // 走实时 overwrite-guard 路径
    expect(diskFiles.get(PATH)).toContain('99');
    expect(T().dirty).toBe(false);
  });

  it('flush 立即落盘', async () => {
    await S().open(PRJ, PATH);
    S().editCell(PATH, 0, 0, '改');
    await S().flush(PATH);
    expect(diskFiles.get(PATH)).toContain('改');
    expect(T().dirty).toBe(false);
  });

  it('manualSnapshot（⌘S）落盘并打 manual 标', async () => {
    await S().open(PRJ, PATH);
    S().editCell(PATH, 0, 0, '钉');
    await S().manualSnapshot(PATH);
    const w = writeTextCalls();
    expect(w[w.length - 1].mark).toBe('manual');
  });
});

describe('多标签按 path 分桶（防串回归 §六）', () => {
  const PATH_B = 'b.csv';
  const CSV_B = 'x,y\n甲,7\n';
  beforeEach(() => {
    diskFiles.set(PATH_B, CSV_B);
  });

  it('A 表 dirty 未落盘，切到 B 表编辑：各自 persist 到各自 path，不串身份', async () => {
    await S().open(PRJ, PATH);
    await S().open(PRJ, PATH_B); // 两表同时开着
    expect(T(PATH).headers).toEqual(['名', '值']);
    expect(T(PATH_B).headers).toEqual(['x', 'y']);

    S().editCell(PATH, 0, 0, 'A改');
    S().editCell(PATH_B, 0, 0, 'B改');
    await S().flush(PATH); // 只 flush A

    expect(diskFiles.get(PATH)).toContain('A改');
    expect(diskFiles.get(PATH_B)).toBe(CSV_B); // B 未落（pending 仍在，互不串）
    expect(T(PATH_B).dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(800); // B 自己的 debounce 到点
    expect(diskFiles.get(PATH_B)).toContain('B改');
  });

  it('A 表排序/筛选不影响 B 表（视图态分桶）', async () => {
    await S().open(PRJ, PATH);
    await S().open(PRJ, PATH_B);
    S().cycleSort(PATH, 0); // A 选中列
    S().cycleSort(PATH, 0); // A 升序
    expect(T(PATH).sort).toEqual({ col: 0, asc: true });
    expect(T(PATH_B).sort).toBeNull(); // B 不受影响
  });

  it('关闭 A 不影响 B', async () => {
    await S().open(PRJ, PATH);
    await S().open(PRJ, PATH_B);
    S().editCell(PATH_B, 0, 0, 'B改');
    S().close(PATH);
    expect(S().tables[PATH]).toBeUndefined();
    expect(T(PATH_B).rows[0]![0]).toBe('B改');
  });
});

describe('Op 撤销栈作 ⌘Z（会话内）', () => {
  it('undo/redo 改内存并重判 dirty', async () => {
    await S().open(PRJ, PATH);
    S().editCell(PATH, 0, 0, '改');
    await S().flush(PATH); // savedText 推进到含「改」
    expect(T().dirty).toBe(false);
    S().undo(PATH); // 撤回到「张三」——与磁盘版不同 → dirty
    expect(T().rows[0]![0]).toBe('张三');
    expect(T().dirty).toBe(true);
    S().redo(PATH);
    expect(T().rows[0]![0]).toBe('改');
  });
});

describe('切回刷新（syncFromDisk）', () => {
  it('本地无改动 + 外部改磁盘 → 刷新成磁盘版', async () => {
    await S().open(PRJ, PATH);
    diskFiles.set(PATH, '名,值\n外部,8\n');
    await S().syncFromDisk(PATH);
    expect(T().rows).toEqual([['外部', '8']]);
  });

  it('本地有改动 + AI 也改磁盘 → AI 覆盖赢（G95：表格撞笔不做冲突卡，PM 2026-07-12）', async () => {
    await S().open(PRJ, PATH);
    S().editCell(PATH, 0, 0, '我的'); // 本地 dirty、未落盘
    diskFiles.set(PATH, '名,值\n外部,8\n'); // AI 写磁盘
    await S().syncFromDisk(PATH);
    expect(T().rows).toEqual([['外部', '8']]); // load 成磁盘版：AI 覆盖赢，本地在途输入被丢（窄窗口，PM 接受）
    expect(T().dirty).toBe(false); // 重读后回到与磁盘一致
  });

  it('本地有改动 + 磁盘没变 → 保住本地（不做无谓刷新，不丢 dirty）', async () => {
    await S().open(PRJ, PATH);
    S().editCell(PATH, 0, 0, '我的'); // 本地 dirty、未落盘；磁盘保持初始
    await S().syncFromDisk(PATH);
    expect(T().rows[0]![0]).toBe('我的'); // 磁盘没变（sha 一致）→ 早返回、保住本地编辑
    expect(T().dirty).toBe(true);
  });
});

describe('选中格去留（场景一·表格，验收7）', () => {
  it('选中格在改动后仍存在（AI 改了别的格）→ 保持选中', async () => {
    await S().open(PRJ, PATH); // headers[名,值] rows[[张三,1],[李四,2]]
    S().setSelection(PATH, { kind: 'range', r1: 0, c1: 0, r2: 0, c2: 0 }); // 选中 张三
    diskFiles.set(PATH, '名,值\n张三,99\n李四,2\n'); // AI 改了值列的另一格
    await S().syncFromDisk(PATH);
    expect(T().rows).toEqual([['张三', '99'], ['李四', '2']]); // 重读到磁盘版
    expect(T().selection).toEqual({ kind: 'range', r1: 0, c1: 0, r2: 0, c2: 0 }); // 选中保持
  });

  it('选中格所在行被删 → 失焦（selection 清空）', async () => {
    await S().open(PRJ, PATH);
    S().setSelection(PATH, { kind: 'range', r1: 1, c1: 0, r2: 1, c2: 0 }); // 选中李四（第2行）
    diskFiles.set(PATH, '名,值\n张三,1\n'); // 李四那行被删
    await S().syncFromDisk(PATH);
    expect(T().selection).toBeNull(); // 行没了 → 失焦，不报错不跳别处
  });

  it('选中列被删 → 失焦', async () => {
    await S().open(PRJ, PATH);
    S().setSelection(PATH, { kind: 'col', col: 1 }); // 选中"值"列
    diskFiles.set(PATH, '名\n张三\n李四\n'); // "值"列被删
    await S().syncFromDisk(PATH);
    expect(T().selection).toBeNull();
  });
});

describe('找回旧版', () => {
  it('restoreFromHistory 载入恢复后的内容、清撤销栈', async () => {
    await S().open(PRJ, PATH);
    S().editCell(PATH, 0, 0, 'x');
    await S().restoreFromHistory(PATH, 's001');
    expect(T().rows).toEqual([['旧版', '9']]);
    expect(T().undoStack).toHaveLength(0);
  });

  it('恢复前先 flush 未落盘编辑（不丢用户刚改、未落盘的格子）', async () => {
    await S().open(PRJ, PATH);
    S().editCell(PATH, 0, 0, '刚改未落盘');
    await S().restoreFromHistory(PATH, 's001');
    expect(writeTextCalls().some((w) => typeof w.content === 'string' && (w.content as string).includes('刚改未落盘'))).toBe(true);
    expect(T().rows).toEqual([['旧版', '9']]);
  });
});

describe('编码不安全的 CSV：三选一（正交保留）', () => {
  it('风格不规范但编码安全：编辑后静默定型落盘、不弹确认', async () => {
    // 回归：判据曾是 canonical（编码 + 风格），使 Excel / 飞书 / AI 经 bash 写出的表每次保存
    // 都弹一句用户无从判断的「要不要转规范」。风格重写无损，不该拦。
    styleUnclean.add(PATH);
    await S().open(PRJ, PATH);
    expect(T().encodingSafe).toBe(true);

    S().editCell(PATH, 0, 0, '改');
    await vi.advanceTimersByTimeAsync(800);
    expect(T().pendingCanonicalConfirm).toBe(false);
    expect(writeTextCalls()).toHaveLength(1); // 静默定型落盘，用户没被问任何问题
  });

  it('编码不安全的文件编辑后自动落盘被拦，弹三选一；转规范后落盘', async () => {
    encodingUnsafe.add(PATH);
    await S().open(PRJ, PATH);
    expect(T().encodingSafe).toBe(false);
    S().editCell(PATH, 0, 0, '改');
    await vi.advanceTimersByTimeAsync(800);
    expect(T().pendingCanonicalConfirm).toBe(true); // 编码不安全：不写、弹确认
    expect(writeTextCalls()).toHaveLength(0);

    await S().resolveCanonical(PATH, 'convert');
    expect(writeTextCalls().length).toBeGreaterThan(0);
    expect(T().encodingSafe).toBe(true);
    expect(T().pendingCanonicalConfirm).toBe(false);
  });

  it('未编辑的不规范文件：flush 不弹确认、不写盘（回归：blur/关标签「什么都没动也弹」）', async () => {
    encodingUnsafe.add(PATH);
    await S().open(PRJ, PATH);
    expect(T().encodingSafe).toBe(false);
    await S().flush(PATH); // 失焦/关标签触发的空 flush——无内容可写
    expect(T().pendingCanonicalConfirm).toBe(false);
    expect(writeTextCalls()).toHaveLength(0);
  });

  it('未编辑的不规范文件：flushAll 不弹确认（回归：AI 动手前 flushAll 误弹）', async () => {
    encodingUnsafe.add(PATH);
    await S().open(PRJ, PATH);
    await S().flushAll(); // AI 动手前落盘所有打开表
    expect(T().pendingCanonicalConfirm).toBe(false);
    expect(writeTextCalls()).toHaveLength(0);
  });

  it('requestCanonicalConfirm 显式弹确认（护住导出路径）；编码安全则 no-op', async () => {
    encodingUnsafe.add(PATH);
    await S().open(PRJ, PATH);
    S().requestCanonicalConfirm(PATH);
    expect(T().pendingCanonicalConfirm).toBe(true); // 编码不安全：显式请求即弹
    await S().resolveCanonical(PATH, 'convert');
    expect(T().encodingSafe).toBe(true);
    S().dismissCanonicalConfirm(PATH);
    S().requestCanonicalConfirm(PATH);
    expect(T().pendingCanonicalConfirm).toBe(false); // 编码已安全：静默 no-op
  });

  it('另存规范副本：原件不动，桶迁到副本', async () => {
    encodingUnsafe.add(PATH);
    await S().open(PRJ, PATH);
    S().editCell(PATH, 0, 0, '改');
    await vi.advanceTimersByTimeAsync(800);
    await S().resolveCanonical(PATH, 'saveCopy');
    expect(diskFiles.get(PATH)).toBe(CSV); // 原件逐字节不动
    expect(S().tables[PATH]).toBeUndefined(); // 原 path 桶迁走
    expect(S().tables['a-规范.csv']).toBeDefined(); // 桶在副本
    expect(diskFiles.has('a-规范.csv')).toBe(true);
  });
});

describe('移动跟随（relocate）', () => {
  it('移动 dirty 表：autosave 重排到新 path 落盘，不丢（回归 M-1）', async () => {
    await S().open(PRJ, PATH);
    S().editCell(PATH, 0, 0, '改'); // dirty + timer 在 a.csv
    S().relocate('a.csv', 'sub/a.csv'); // 移动（timer 闭包原指向旧 path）
    expect(S().tables['sub/a.csv']).toBeDefined();
    await vi.advanceTimersByTimeAsync(800); // 重排后的 timer 到点
    expect(diskFiles.get('sub/a.csv')).toContain('改'); // 落到新 path（旧实现 no-op 丢掉）
  });
});

describe('超限只读', () => {
  it('超限文件只读预览、不自动落盘', async () => {
    overLimitPaths.add(PATH);
    await S().open(PRJ, PATH);
    expect(T().overLimit).toBe(true);
    await S().flush(PATH); // 超限：persist 直接 return
    expect(writeTextCalls()).toHaveLength(0);
  });
});

describe('表格视图偏好（列宽/行高）', () => {
  it('open 回执带 prefs → 桶里有值', async () => {
    prefsFiles.set(PATH, { columnWidths: [120, 200], rowHeightPx: 32 });
    await S().open(PRJ, PATH);
    expect(T().prefs).toEqual({ columnWidths: [120, 200], rowHeightPx: 32 });
  });

  it('open 回执 prefs 为 null → 桶 prefs 落 {}', async () => {
    await S().open(PRJ, PATH); // 默认 prefsFiles 空 → 回执 prefs: null
    expect(T().prefs).toEqual({});
  });

  it('commitColumnWidths 更新桶后 debounce 落盘（发完整 prefs）', async () => {
    prefsFiles.set(PATH, { rowHeightPx: 28 }); // 已有行高偏好
    await S().open(PRJ, PATH);
    S().commitColumnWidths(PATH, [100, 150]);
    expect(T().prefs).toEqual({ rowHeightPx: 28, columnWidths: [100, 150] }); // 桶同步更新
    expect(prefsSets).toHaveLength(0); // 未到点不发
    await vi.advanceTimersByTimeAsync(800);
    expect(prefsSets).toHaveLength(1);
    expect(prefsSets[0]).toMatchObject({
      type: 'table.prefs.set', projectId: PRJ, path: PATH,
      prefs: { rowHeightPx: 28, columnWidths: [100, 150] }, // 发完整 prefs
    });
  });

  it('commitColumnWidths 后未到 800ms 即 close → flush 兜底发出 set、计时器已清理', async () => {
    await S().open(PRJ, PATH);
    S().commitColumnWidths(PATH, [80, 90]);
    expect(prefsSets).toHaveLength(0);
    S().close(PATH); // 800ms 内关闭
    // flush 兜底：偏好仍被发出，不静默丢
    expect(prefsSets).toHaveLength(1);
    expect(prefsSets[0].prefs).toEqual({ columnWidths: [80, 90] });
    // 计时器已清理：再推进时间不会有第二次发送（无悬挂 timer）
    await vi.advanceTimersByTimeAsync(800);
    expect(prefsSets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('commitRowHeight 拖拽结束 → debounce；档位点击（immediate）→ 立即发', async () => {
    await S().open(PRJ, PATH);
    // 拖拽：debounce
    S().commitRowHeight(PATH, 40);
    expect(T().prefs.rowHeightPx).toBe(40);
    expect(prefsSets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(800);
    expect(prefsSets).toHaveLength(1);
    expect(prefsSets[0].prefs).toEqual({ rowHeightPx: 40 });

    // 档位点击：immediate，不等 debounce
    S().commitRowHeight(PATH, 56, { immediate: true });
    expect(T().prefs.rowHeightPx).toBe(56);
    expect(prefsSets).toHaveLength(2); // 立即发出
    expect(prefsSets[1].prefs).toEqual({ rowHeightPx: 56 });
  });

  it('commitRowHeightAt 单行覆盖：写进 rowHeightsPx[row]、多行合并、debounce 落盘发完整 prefs', async () => {
    prefsFiles.set(PATH, { rowHeightPx: 28 }); // 整表默认已存在
    await S().open(PRJ, PATH);

    // 拖第 2 行 → 覆盖只落在这一行，整表默认不动
    S().commitRowHeightAt(PATH, 2, 60);
    expect(T().prefs).toEqual({ rowHeightPx: 28, rowHeightsPx: { 2: 60 } });
    expect(prefsSets).toHaveLength(0); // 拖拽走 debounce，未到点不发

    // 再拖第 5 行 → 与既有覆盖合并，不互相覆盖
    S().commitRowHeightAt(PATH, 5, 44);
    expect(T().prefs).toEqual({ rowHeightPx: 28, rowHeightsPx: { 2: 60, 5: 44 } });

    await vi.advanceTimersByTimeAsync(800);
    expect(prefsSets).toHaveLength(1); // debounce 合并成一次落盘
    expect(prefsSets[0]).toMatchObject({
      type: 'table.prefs.set',
      prefs: { rowHeightPx: 28, rowHeightsPx: { 2: 60, 5: 44 } }, // 发桶内完整 prefs
    });
  });

  it('删行让行高覆盖跟数据走：删掉那行的高度、其后的行索引下移，并落盘', async () => {
    prefsFiles.set(PATH, { rowHeightsPx: { 0: 60, 1: 44 } }); // 两行各有覆盖
    await S().open(PRJ, PATH);

    S().deleteRow(PATH, 0); // 删第 0 行 → 它的 60 没了；原第 1 行成第 0 行，44 跟着挪
    expect(T().prefs.rowHeightsPx).toEqual({ 0: 44 });

    await vi.advanceTimersByTimeAsync(800);
    const set = prefsSets.at(-1)!;
    expect(set.prefs).toEqual({ rowHeightsPx: { 0: 44 } }); // 重排后的 prefs 落盘（重开不复现错位）
  });

  it('插行让行高覆盖整体下移：插入点及之后 +1，新行无覆盖', async () => {
    prefsFiles.set(PATH, { rowHeightsPx: { 0: 60, 1: 44 } });
    await S().open(PRJ, PATH);

    S().insertRow(PATH, 0); // 头部插一行 → 原 0/1 变 1/2
    expect(T().prefs.rowHeightsPx).toEqual({ 1: 60, 2: 44 });
  });

  it('删行撤销：被删那行的高度一并恢复（op 带原高度）', async () => {
    prefsFiles.set(PATH, { rowHeightsPx: { 0: 60, 1: 44 } });
    await S().open(PRJ, PATH);

    S().deleteRow(PATH, 0);
    expect(T().prefs.rowHeightsPx).toEqual({ 0: 44 });
    S().undo(PATH); // 数据回来了，高度也回来
    expect(T().prefs.rowHeightsPx).toEqual({ 0: 60, 1: 44 });
  });

  it('删行撤销：唯一有覆盖的那行被删后，撤销仍能把它的高度找回（map 一度空掉的边界）', async () => {
    prefsFiles.set(PATH, { rowHeightsPx: { 0: 60 } }); // 只有第 0 行有覆盖
    await S().open(PRJ, PATH);

    S().deleteRow(PATH, 0);
    expect(T().prefs.rowHeightsPx).toEqual({}); // map 空掉但仍是 {}（非 undefined）
    S().undo(PATH);
    expect(T().prefs.rowHeightsPx).toEqual({ 0: 60 }); // 被删行的高度找回
  });

  it('删列让列宽跟数据走 + 撤销恢复被删列宽', async () => {
    prefsFiles.set(PATH, { columnWidths: [100, 200] });
    await S().open(PRJ, PATH);

    S().deleteCol(PATH, 0); // 删第 0 列 → 列宽数组前移
    expect(T().prefs.columnWidths).toEqual([200]);
    S().undo(PATH);
    expect(T().prefs.columnWidths).toEqual([100, 200]);
  });

  it('插列在插入位留默认列宽，不错位后续列宽', async () => {
    prefsFiles.set(PATH, { columnWidths: [100, 200] });
    await S().open(PRJ, PATH);

    S().insertCol(PATH, 1); // 在第 1 列前插 → 新列无覆盖（回落默认），原 200 挪到末位
    expect(T().prefs.columnWidths).toEqual([100, undefined, 200]);
  });

  it('无行高/列宽偏好的表增删行：不生成 undefined 偏好、不触发 prefs 落盘', async () => {
    await S().open(PRJ, PATH); // 无 prefs（prefsFiles 空 → 桶 prefs = {}）
    S().deleteRow(PATH, 0);
    expect(T().prefs).toEqual({}); // 不冒出 { rowHeightsPx: undefined }
    S().insertRow(PATH, 0);
    expect(T().prefs).toEqual({});
    await vi.advanceTimersByTimeAsync(800);
    expect(prefsSets).toHaveLength(0); // 结构编辑本身不产生偏好写
  });

  it('移动 dirty 偏好表：prefsTimer 重排到新 path 落盘，不丢', async () => {
    await S().open(PRJ, PATH);
    S().commitColumnWidths(PATH, [88]); // 偏好 pending，timer 在 a.csv
    S().relocate('a.csv', 'sub/a.csv');
    await vi.advanceTimersByTimeAsync(800);
    expect(prefsSets).toHaveLength(1);
    expect(prefsSets[0].path).toBe('sub/a.csv'); // 落到新 path（旧实现 no-op 丢掉）
    expect(prefsSets[0].prefs).toEqual({ columnWidths: [88] });
  });

  it('列宽与行高偏好计时器不互相 cancel（独立 prefsTimers）', async () => {
    await S().open(PRJ, PATH);
    S().commitColumnWidths(PATH, [70]);
    S().commitRowHeight(PATH, 44); // 若共用 timer 会 cancel 掉列宽那次
    await vi.advanceTimersByTimeAsync(800);
    // 两者合入同一 prefs、最后一次 debounce 落盘发完整 prefs
    const last = prefsSets[prefsSets.length - 1]!;
    expect(last.prefs).toEqual({ columnWidths: [70], rowHeightPx: 44 });
  });
});

/**
 * block op —— 粘贴 / Delete 清空 / 全部替换共用的整块原子写。
 *
 * 承重不变量：
 *   - rows 是**文件行号数组**：排序筛选后视图上连续的几行，文件里可能是第 5、17、203 行。
 *     数组让「无排序无筛选」退化成恰好连续的特例，一个代码路径覆盖全部视图状态。
 *   - apply→invert 后模型逐格回到原状，扩出来的行列被干净截掉。
 *   - 截回维度后，指向已不存在行/列的行高/列宽覆盖必须一并丢弃——否则成孤儿键，
 *     下次行列数长回同一下标时，全新的行会凭空继承几步之前的旧行高。
 */
describe('block op（整块原子写）', () => {
  beforeEach(async () => {
    await S().open(PRJ, PATH); // headers ['名','值']；rows [['张三','1'],['李四','2']]
  });

  it('不扩表：按 rows 指定的文件行逐格覆盖', () => {
    S().writeBlock(PATH, [0, 1], 0, [
      ['A', 'B'],
      ['C', 'D'],
    ]);
    expect(T().rows).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    expect(T().headers).toEqual(['名', '值']); // 表头不受影响
  });

  it('rows 离散（排序筛选后的可见行）时写入落在正确的文件行', async () => {
    diskFiles.set('d.csv', 'h\na\nb\nc\nd\n');
    await S().open(PRJ, 'd.csv');
    S().writeBlock('d.csv', [0, 3], 0, [['X'], ['Y']]); // 跳过中间两行
    expect(T('d.csv').rows).toEqual([['X'], ['b'], ['c'], ['Y']]);
  });

  it('扩行：rows 含超出末尾的行号 → 表尾追加空行后写入', () => {
    S().writeBlock(PATH, [1, 2, 3], 0, [
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ]);
    expect(T().rows).toEqual([
      ['张三', '1'],
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ]);
  });

  it('扩列：表头补齐，未被写的行保持原宽（行宽逐行独立）', () => {
    S().writeBlock(PATH, [0], 1, [['x', 'y', 'z']]); // 从第 1 列写 3 格 → 需要 4 列
    expect(T().headers).toEqual(['名', '值', '', '']);
    expect(T().rows).toEqual([
      ['张三', 'x', 'y', 'z'],
      ['李四', '2'], // 未被写的行不动——补齐它等于顺手改了它，且撤销时无从知道它原本多宽
    ]);
  });

  it('撤销后模型逐格回到原状（同时扩行扩列）', () => {
    const before = { headers: T().headers, rows: T().rows };
    S().writeBlock(PATH, [1, 2], 1, [
      ['p', 'q'],
      ['r', 's'],
    ]);
    S().undo(PATH);
    expect(T().headers).toEqual(before.headers);
    expect(T().rows).toEqual(before.rows);
  });

  it('撤销把扩出来的行列干净截掉，不留空行空列', () => {
    S().writeBlock(PATH, [5], 4, [['远']]);
    expect(T().rows.length).toBe(6);
    expect(T().headers.length).toBe(5);
    S().undo(PATH);
    expect(T().rows.length).toBe(2);
    expect(T().headers.length).toBe(2);
    expect(T().rows.every((r) => r.length === 2)).toBe(true);
  });

  it('撤销后只丢掉越界的行高覆盖，存活行的保持不动', async () => {
    S().commitRowHeightAt(PATH, 0, 40); // 一直存在的行
    S().writeBlock(PATH, [2, 3], 0, [['a'], ['b']]); // 扩到 4 行
    S().commitRowHeightAt(PATH, 3, 60); // 只在扩出来的新行上
    await vi.advanceTimersByTimeAsync(800);
    expect(T().prefs.rowHeightsPx).toEqual({ 0: 40, 3: 60 });
    S().undo(PATH);
    // 断言整体形状而非只看被删的那个键——否则「把 rowHeightsPx 一把清空」的实现也能过
    expect(T().prefs.rowHeightsPx).toEqual({ 0: 40 });
  });

  it('撤销后不残留已截掉列的列宽覆盖', async () => {
    S().commitColumnWidths(PATH, [70, 80]);
    await vi.advanceTimersByTimeAsync(800);
    S().writeBlock(PATH, [0], 2, [['x']]); // 扩到 3 列
    S().commitColumnWidths(PATH, [70, 80, 90]);
    await vi.advanceTimersByTimeAsync(800);
    S().undo(PATH);
    expect(T().prefs.columnWidths).toEqual([70, 80]);
  });

  it('redo 重放整块写', () => {
    S().writeBlock(PATH, [0], 0, [['改']]);
    S().undo(PATH);
    expect(T().rows[0]).toEqual(['张三', '1']);
    S().redo(PATH);
    expect(T().rows[0]).toEqual(['改', '1']);
  });

  it('clearBlock 清空选中格，一次撤销全回来', () => {
    S().clearBlock(PATH, [0, 1], 0, 2);
    expect(T().rows).toEqual([
      ['', ''],
      ['', ''],
    ]);
    S().undo(PATH);
    expect(T().rows).toEqual([
      ['张三', '1'],
      ['李四', '2'],
    ]);
  });

  it('参差行（中部空行）写入后撤销，序列化逐字节还原', async () => {
    // parseCsv('a,b\n\nc,d\n').rows === [[''], ['c','d']]——中部空行是合法数据，
    // 它比表头短。写入会把这行补齐到满列，撤销必须按**该行原来的宽度**截回，
    // 否则落盘会多出逗号：a,b\n,\nc,d\n
    diskFiles.set('ragged.csv', 'a,b\n\nc,d\n');
    await S().open(PRJ, 'ragged.csv');
    const snapshot = () => serializeCsv({ headers: T('ragged.csv').headers, rows: T('ragged.csv').rows });
    const before = snapshot();
    expect(before).toBe('a,b\n\nc,d\n');
    S().writeBlock('ragged.csv', [0], 0, [['X']]);
    S().undo('ragged.csv');
    expect(snapshot()).toBe(before);
  });

  it('超过行数上限整个 op 拒绝执行，模型不变，不静默截断', () => {
    const before = T().rows;
    const ok = S().writeBlock(PATH, [100_000], 0, [['越界']]); // 需要 100_001 数据行
    expect(ok).toBe(false);
    expect(T().rows).toBe(before); // 同一引用：一格都没动
  });

  it('粘贴不清选区、不清排序筛选（非结构 op）', () => {
    // cycleSort 第一次只「选中该列」、第二次才真排序——只调一次的话 sort 恒为 null，断言恒真
    S().cycleSort(PATH, 0);
    S().cycleSort(PATH, 0);
    S().setFilter(PATH, 1, new Set(['1', '2']));
    const sel = { kind: 'range', r1: 0, c1: 0, r2: 1, c2: 1 } as const;
    S().setSelection(PATH, sel);
    expect(T().sort).not.toBeNull(); // 前置成立才谈得上「不清」
    S().writeBlock(PATH, [0], 0, [['改']]);
    expect(T().selection).toEqual(sel); // 原样保留，不只是「非 null」
    expect(T().sort).toEqual({ col: 0, asc: true });
    expect(T().filters.size).toBe(1);
  });

  it('超限只读表拒绝整块写', async () => {
    overLimitPaths.add('big.csv');
    diskFiles.set('big.csv', CSV);
    await S().open(PRJ, 'big.csv');
    expect(S().writeBlock('big.csv', [0], 0, [['x']])).toBe(false);
  });
});
