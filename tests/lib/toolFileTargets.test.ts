/**
 * toolFileTargets —— 「本轮文件变更」条 / 打开按钮的文件判定。
 *
 * 两段历史口径都在这里回归：
 * - 2026-07-27 PRD 第 8 项：显示按归属项目反查、打开按当前项目（canOpenTarget 叠加判定）。
 * - 2026-07-28 PRD 第 7 项·决策二：四种操作全进（新 fileChanges 标记）、遗留 file 标记仍认、
 *   打开入口只给仍存在（op≠delete）且当前项目可达的文件。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Project, ToolCall } from '@shared/types';
import type { StructuredMarkers } from '@shared/agent/structuredMarkers';
import { canOpenTarget, fileChangeTargets } from '@/lib/toolFileTargets';
import { collectTurnFileChanges } from '@/components/chat/TurnFileChangesStrip';
import { owningProject } from '@/lib/openProjectFile';
import { useProjectStore } from '@/stores/projectStore';

function mkProject(id: string, path: string): Project {
  return {
    id,
    ownerId: 'local-user',
    name: `项目 ${id}`,
    path,
    addedAt: 0,
    lastOpenedAt: 0,
    hasClaudeMd: false,
  };
}

let seq = 0;
function mkTool(name: string, structured: StructuredMarkers): ToolCall {
  return {
    id: `tc_${seq++}`,
    name,
    input: {},
    status: 'success',
    result: { content: 'ok', structured },
    startedAt: 0,
  };
}

/** 遗留形状（2026-07-28 前落盘的历史消息） */
function mkLegacyWrite(absPath: string, created = false): ToolCall {
  return mkTool('write_file', { file: { path: absPath, created } });
}

beforeEach(() => {
  useProjectStore.setState({
    projects: [mkProject('pA', '/work/projA'), mkProject('pB', '/work/projB')],
    activeProjectId: 'pA',
  });
});

describe('owningProject（按绝对路径反查归属项目）', () => {
  it('前缀互含的项目根不误判（/work/projA 与 /work/projA-2）', () => {
    useProjectStore.setState({
      projects: [mkProject('pA', '/work/projA'), mkProject('pA2', '/work/projA-2')],
      activeProjectId: 'pA',
    });
    expect(owningProject('/work/projA-2/doc.md')).toEqual({ id: 'pA2', relPath: 'doc.md' });
  });

  it('嵌套项目根取最长前缀：文件归最内层项目，与列表顺序无关', () => {
    useProjectStore.setState({
      projects: [mkProject('outer', '/work'), mkProject('inner', '/work/projA')],
      activeProjectId: 'inner',
    });
    expect(owningProject('/work/projA/doc.md')).toEqual({ id: 'inner', relPath: 'doc.md' });
  });
});

describe('fileChangeTargets（标记 → 显示条目）', () => {
  it('遗留 file 标记仍认：created=true → create、false → modify', () => {
    expect(fileChangeTargets(mkLegacyWrite('/work/projA/notes/draft.md', true))).toEqual([
      { projectId: 'pA', relPath: 'notes/draft.md', op: 'create', openable: true },
    ]);
    expect(fileChangeTargets(mkLegacyWrite('/work/projA/notes/draft.md'))[0]?.op).toBe('modify');
  });

  it('文件属另一项目 → 仍显示（PRD 第 8 项回归：显示按归属项目反查）', () => {
    expect(fileChangeTargets(mkLegacyWrite('/work/projB/notes/draft.md'))[0]?.projectId).toBe('pB');
  });

  it('manage_files delete/rename：op 照标记，rename 带 fromKey 供聚合并入', () => {
    const del = fileChangeTargets(
      mkTool('manage_files', { fileChanges: [{ path: '/work/projA/old.md', op: 'delete' }] }),
    );
    expect(del).toEqual([{ projectId: 'pA', relPath: 'old.md', op: 'delete', openable: true }]);
    const ren = fileChangeTargets(
      mkTool('manage_files', {
        fileChanges: [{ path: '/work/projA/new.md', op: 'rename', from: '/work/projA/old.md' }],
      }),
    );
    expect(ren).toEqual([
      { projectId: 'pA', relPath: 'new.md', op: 'rename', openable: true, fromKey: 'pA:old.md' },
    ]);
  });

  it('bash 多文件标记 → 多条目；项目外的路径过滤掉', () => {
    const targets = fileChangeTargets(
      mkTool('bash', {
        fileChanges: [
          { path: '/work/projA/out1.csv', op: 'create' },
          { path: '/work/projA/out2.csv', op: 'modify' },
          { path: '/elsewhere/out3.csv', op: 'create' },
        ],
      }),
    );
    expect(targets.map((t) => t.relPath)).toEqual(['out1.csv', 'out2.csv']);
  });

  it('白名单外的工具即使带同形状标记也不采信（fail-closed）', () => {
    expect(
      fileChangeTargets(
        mkTool('mcp__ext__anything', { fileChanges: [{ path: '/work/projA/x.md', op: 'create' }] }),
      ),
    ).toEqual([]);
  });
});

describe('canOpenTarget（打开入口：仍存在 + 当前项目可达 + 类型可开）', () => {
  const base = { projectId: 'pA', relPath: 'a.md', op: 'modify', openable: true } as const;
  it('三路拒：已删除 / 跨项目 / 类型不可开', () => {
    expect(canOpenTarget({ ...base, op: 'delete' }, 'pA')).toBe(false);
    expect(canOpenTarget(base, 'pB')).toBe(false);
    expect(canOpenTarget({ ...base, openable: false }, 'pA')).toBe(false);
  });
  it('当前项目内可开类型 → 放行', () => {
    expect(canOpenTarget(base, 'pA')).toBe(true);
  });
});

describe('collectTurnFileChanges（聚合与净状态）', () => {
  it('两个项目下同名相对路径 → 两条记录，不静默合并', () => {
    const targets = collectTurnFileChanges([
      mkLegacyWrite('/work/projA/report.md', true),
      mkLegacyWrite('/work/projB/report.md'),
    ]);
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.projectId).sort()).toEqual(['pA', 'pB']);
  });

  it('同路径先建后改 → 合并为一条、仍标新建', () => {
    const targets = collectTurnFileChanges([
      mkLegacyWrite('/work/projA/report.md', true),
      mkLegacyWrite('/work/projA/report.md'),
    ]);
    expect(targets).toEqual([
      { projectId: 'pA', relPath: 'report.md', op: 'create', openable: true },
    ]);
  });

  it('先改后删 → 净状态是删除（打开入口随之消失）', () => {
    const targets = collectTurnFileChanges([
      mkLegacyWrite('/work/projA/report.md'),
      mkTool('manage_files', { fileChanges: [{ path: '/work/projA/report.md', op: 'delete' }] }),
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0].op).toBe('delete');
  });

  it('本轮新建又改名 → 旧路径条目并入新路径、仍标新建（不给已不存在的旧路径留条目）', () => {
    const targets = collectTurnFileChanges([
      mkLegacyWrite('/work/projA/draft.md', true),
      mkTool('manage_files', {
        fileChanges: [{ path: '/work/projA/final.md', op: 'rename', from: '/work/projA/draft.md' }],
      }),
    ]);
    expect(targets).toEqual([
      { projectId: 'pA', relPath: 'final.md', op: 'create', openable: true },
    ]);
  });

  it('同轮写 tmp/a.md 再删 tmp 目录 → 条上只剩目录删除、无可点的 a.md（前缀按路径边界，不误伤 tmp2/）', () => {
    const targets = collectTurnFileChanges([
      mkLegacyWrite('/work/projA/tmp/a.md', true),
      mkLegacyWrite('/work/projA/tmp2/b.md', true),
      mkTool('manage_files', { fileChanges: [{ path: '/work/projA/tmp', op: 'delete' }] }),
    ]);
    expect(targets.map((t) => `${t.relPath}:${t.op}`).sort()).toEqual([
      'tmp2/b.md:create',
      'tmp:delete',
    ]);
  });

  it('目录级 rename：旧前缀下的子条目迁到新前缀、op 保持（净状态跟着文件走）', () => {
    const targets = collectTurnFileChanges([
      mkLegacyWrite('/work/projA/tmp/a.md', true),
      mkTool('manage_files', {
        fileChanges: [{ path: '/work/projA/docs', op: 'rename', from: '/work/projA/tmp' }],
      }),
    ]);
    expect(targets.map((t) => `${t.relPath}:${t.op}`).sort()).toEqual([
      'docs/a.md:create',
      'docs:rename',
    ]);
  });
});
