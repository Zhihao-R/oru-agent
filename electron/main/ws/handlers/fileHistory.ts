/**
 * fileHistory.* 命令处理器（D2(a) 迁移域）。
 * list/get/restore/clear 行为与原 router.ts switch 字节级一致——纯搬运。
 */
import type { RegistrySlice } from './types';
import { getProject, getSettings } from '../../projects/store';
import { ensureWithinProject } from '../../fs/projectPath';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import * as fileHistory from '../../fs/fileHistory';
import { restoreWorkfileSnapshot, recordDiscardedContent } from '../../fs/workfileWrite';
import { markConflictOpen, clearConflict } from '../../fs/conflictRegistry';
import { feedConflictRecoverable } from '../../notifications/feeds';
import { resumeDeferredWritesAfterResolve } from './conflictResume';

export const fileHistoryHandlers = {
  'fileHistory.list': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    const abs = await ensureWithinProject(project.path, req.path);
    const snapshots = await fileHistory.listForUser(abs);
    reply(req.reqId, {
      type: 'fileHistory.list.result',
      projectId: req.projectId,
      path: req.path,
      snapshots,
    });
  },
  'fileHistory.get': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    const abs = await ensureWithinProject(project.path, req.path);
    const content = await fileHistory.restore(abs, req.snapshotId);
    reply(req.reqId, {
      type: 'fileHistory.content',
      projectId: req.projectId,
      path: req.path,
      snapshotId: req.snapshotId,
      content,
    });
  },
  'fileHistory.restore': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    const abs = await ensureWithinProject(project.path, req.path);
    const content = await restoreWorkfileSnapshot(abs, req.snapshotId);
    reply(req.reqId, {
      type: 'fileHistory.restored',
      projectId: req.projectId,
      path: req.path,
      content,
    });
    broadcast({ type: 'fs.changed', projectId: req.projectId });
  },
  'fileHistory.clear': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    const abs = await ensureWithinProject(project.path, req.path);
    await fileHistory.clear(abs);
    reply(req.reqId, { type: 'ack' });
  },
  // S29·G90①③ 开冲突卡：双方版本入历史（防收起前崩溃丢未落盘 mine）+ 登记未决冲突（AI 后续写入据此 defer）。
  'conflictCard.opened': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    const abs = await ensureWithinProject(project.path, req.path);
    const { mineId, theirsId } = await fileHistory.snapshotConflictPair(abs, req.mine, req.theirs);
    markConflictOpen(abs);
    reply(req.reqId, { type: 'conflictCard.opened.result', mineId, theirsId });
  },
  // S29·G90②③ 冲突卡收起：按出口补标（落选补 conflict-losing、拼合双方留 conflict-version）+ 撤登记 +
  // 起新轮把裁决交回被挂起的 AI 写入（不等用户再开口）。
  'conflictCard.resolved': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    const abs = await ensureWithinProject(project.path, req.path);
    if (req.outcome === 'mine') await fileHistory.retagSnapshot(abs, req.theirsId, 'conflict-losing');
    else if (req.outcome === 'theirs') await fileHistory.retagSnapshot(abs, req.mineId, 'conflict-losing');
    // 'both'（手动拼合）：双方都留 conflict-version、不补落选标（无全胜方）。
    // 'cancelled'（关标签/改名等未裁决就撤卡）：不补标——仍撤登记并交回 AI（别让它永久 defer）。
    const convIds = clearConflict(abs);
    reply(req.reqId, { type: 'ack' });
    const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
    void resumeDeferredWritesAfterResolve({ convIds, path: abs, outcome: req.outcome, lang, broadcast });
  },
  // S29·G90⑤ 弃写降级：无编辑器接住在途内容时，把它降级写进历史打 discarded 标（可找回），磁盘保留 AI 版。
  'fileHistory.recordDiscarded': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    const abs = await ensureWithinProject(project.path, req.path);
    await recordDiscardedContent(abs, req.content);
    feedConflictRecoverable(1); // 提示可找回（与崩溃重开同款信号）
    reply(req.reqId, { type: 'ack' });
  },
} satisfies RegistrySlice;
