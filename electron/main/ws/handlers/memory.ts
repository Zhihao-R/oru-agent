/**
 * memory.* 命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内「记忆系统 v0.1」与「记忆系统 v2 Page IPC」两小节各 case 字节级一致——纯搬运。
 * 注：handler 比 router 深一层目录，相对 import 路径相应多一层 `../`。
 */
import { ErrorCodes } from '@shared/types';
import type { EpisodeWithBody } from '@shared/types';
import type { RegistrySlice } from './types';
import { moveToTrash } from '../../memory/trash';
import { resolveRevertTarget } from '../../memory/revert';
import { restoreWorkfileSnapshot } from '../../fs/workfileWrite';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { t } from '../../i18n/t';
import { getSettings } from '../../projects/store';
import { changelogPath } from '../../memory/changelog';
import { runOnce as dreamRunOnce } from '../../memory/dreamScheduler';
import {
  readAgentSelf,
  readEpisode,
  listAllEpisodesWithSuperseded,
  readPredecessor,
} from '../../memory/store';
import { applyOps as applyMemoryOps } from '../../memory/applyOps';
import { readProjectProfile } from '../../memory/projectProfile';
import { readAllProjectListEntriesForUI } from '../../memory/projectList';
import { ensureWithinRoot, readMarkdownFile, stringifyFrontmatter } from '../../fs/frontmatter';
import { writeMemoryDocument } from '../../memory/documentIo';
import { parseProfileDoc, renderProfileDoc, type ProfileDoc } from '@shared/memory/profileDoc';
import { memoryRoot } from '../../memory/paths';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getCurrentOwnerId } from '../../identity/getCurrentOwnerId';
import { readHistory, patchMessage } from '../../conversations/store';
import { errMsg } from '../errors';

/**
 * 读某份自由分章档案为 ProfileDoc + frontmatter 的 last-updated（沙箱内、文件不存在回空档案）。
 * last-updated 是系统自管元数据（documentIo 写时自动刷新），单独透传供手账「修订 MM·DD」显示（C5）。
 */
async function readProfileDocAt(
  ownerId: string,
  relPath: string,
): Promise<{ doc: ProfileDoc; lastUpdated: string | undefined }> {
  const abs = ensureWithinRoot(memoryRoot(ownerId), relPath);
  const f = await readMarkdownFile(abs);
  if (!f) return { doc: { impression: '', sections: [] }, lastUpdated: undefined };
  return {
    doc: parseProfileDoc(f.content),
    lastUpdated: (f.data as { 'last-updated'?: string })['last-updated'],
  };
}

export const memoryHandlers = {
  // ─── 记忆系统（v0.1） ─────────────────────────────────────
  'memory.undo': async (req, { reply, broadcast }) => {
    try {
      const ownerId = getCurrentOwnerId();
      const abs = join(memoryRoot(ownerId), req.relPath);
      // 档案类（带 revertHash）回滚这一次写入，episode 才是整条移进回收站——档案是一份连续文档，
      // 挪走文件等于把整份画像清零，而卡片承诺的只是「撤回这次修改」。
      if (req.revertHash) {
        const target = await resolveRevertTarget(abs, req.revertHash);
        // 锁外校验只为早失败给出准确原因；能不能撤最终由 restoreWorkfileSnapshot 锁内重判
        // （expectCurrentHash）——两次 await 之间档案可能又被写过。
        const reason = target.ok
          ? await restoreWorkfileSnapshot(abs, target.snapshotId, { expectCurrentHash: req.revertHash }).then(
              () => null,
              (e: Error & { code?: string }) => {
                if (e.code === 'WORKFILE_RESTORE_STALE') return 'changed-since' as const;
                throw e;
              },
            )
          : target.reason;
        if (reason) {
          const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
          reply(req.reqId, {
            type: 'error',
            code: ErrorCodes.MEMORY_REVERT_UNAVAILABLE,
            message: t(`main:memoryRevert.${reason}`, lang),
          });
          return;
        }
      } else {
        await moveToTrash(ownerId, abs);
      }
      // 撤销已生效——把 undone 落盘回对话 JSONL，重载后卡片仍显示「已撤销」。
      // patchMessage 是浅合并、整体替换 memoryRecord：必须先读现有 payload 拼上 undone，
      // 直接传 { undone: true } 会抹掉 relPath/scope/type 等字段。
      // 落盘失败不回滚已完成的撤销、不改回执——仅缺持久化标记，warn 留痕（同 persistDecision）。
      try {
        const msgs = await readHistory(req.agentId, req.conversationId);
        const record = msgs.find((m) => m.id === req.messageId)?.memoryRecord;
        if (record) {
          await patchMessage(req.agentId, req.conversationId, req.messageId, {
            memoryRecord: { ...record, undone: true },
          });
        }
      } catch (e) {
        console.warn('[memory.undo] 撤销状态落盘失败（撤销本身已生效）:', errMsg(e));
      }
      broadcast({
        type: 'chat.memoryUndone',
        conversationId: req.conversationId,
        messageId: req.messageId,
      });
      reply(req.reqId, { type: 'ack' });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  'memory.listEpisodes': async (req, { reply }) => {
    try {
      const ownerId = getCurrentOwnerId();
      const includeSuperseded = req.includeSuperseded === true;
      const summaries = await listAllEpisodesWithSuperseded(ownerId, includeSuperseded);
      reply(req.reqId, {
        type: 'memory.episodes.result',
        episodes: summaries,
      });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  'memory.readEpisode': async (req, { reply }) => {
    try {
      const ownerId = getCurrentOwnerId();
      const ep = await readEpisode(ownerId, req.relPath);
      if (!ep) {
        reply(req.reqId, {
          type: 'error',
          code: ErrorCodes.UNKNOWN,
          message: `事件不存在：${req.relPath}`,
        });
        return;
      }
      // 拼回完整 markdown（含 frontmatter）便于 UI 显示
      const full = stringifyFrontmatter(
        ep.frontmatter as Record<string, unknown>,
        ep.body,
      );
      // title 兜底：用文件名 slug
      const fname = req.relPath.split('/').pop() ?? '';
      const fallbackTitle = fname.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
      reply(req.reqId, {
        type: 'memory.episode.content.result',
        relPath: req.relPath,
        content: full,
        status: ep.frontmatter.status ?? 'active',
        title: (ep.frontmatter as { title?: string }).title ?? fallbackTitle,
        tags: ep.frontmatter.tags ?? [],
      });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  'memory.deleteEpisode': async (req, { reply }) => {
    try {
      const ownerId = getCurrentOwnerId();
      const abs = join(memoryRoot(ownerId), req.relPath);
      await moveToTrash(ownerId, abs);
      reply(req.reqId, { type: 'ack' });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  'memory.readChangelog': async (req, { reply }) => {
    try {
      const ownerId = getCurrentOwnerId();
      const content = await fs
        .readFile(changelogPath(ownerId), 'utf-8')
        .catch(() => '');
      reply(req.reqId, { type: 'memory.changelog.result', content });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  'memory.dream.runNow': async (req, { reply }) => {
    try {
      const summary = await dreamRunOnce('manual');
      reply(req.reqId, { type: 'memory.dream.runNow.result', summary });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },

  // ─── 记忆系统 v2 Page IPC ──────────────────────────────────
  'memory.applyOps': async (req, { reply }) => {
    try {
      const ownerId = getCurrentOwnerId();
      // 默认 'ui'（更窄权限）——任何忘传 origin 的新 IPC 调用方不会获得 LLM 的 episode 写权限。
      // 后端代码（record_memory / capture / dream）都显式传 origin，前端 memoryStore 显式传 'ui'。
      const result = await applyMemoryOps(ownerId, req.ops, req.origin ?? 'ui');
      reply(req.reqId, { type: 'memory.applyOps.result', result });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  // memory.userProfile.read 已退役——用户档案改走 memory.doc.read（文档模型，返回 ProfileDoc）。
  // 自由分章档案读：raw 正文 → parseProfileDoc → ProfileDoc（文件不存在 = 空档案）
  'memory.doc.read': async (req, { reply }) => {
    try {
      const ownerId = getCurrentOwnerId();
      const { doc, lastUpdated } = await readProfileDocAt(ownerId, req.relPath);
      reply(req.reqId, { type: 'memory.doc.result', relPath: req.relPath, doc, lastUpdated });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  // 自由分章档案写：前端改完 ProfileDoc 结构整篇回传 → renderProfileDoc + writeMemoryDocument（沙箱+原子+锁）
  // → read-after-write 回 ProfileDoc 供前端刷新。整篇覆盖即「永不丢小节」——前端把要留的小节都带回来了。
  // 落盘后广播 memory.doc.changed（Task 3），让已打开的档案编辑器感知刷新。独立于 fs.changed，避免波及项目文件 store。
  'memory.doc.write': async (req, { reply, broadcast }) => {
    try {
      const ownerId = getCurrentOwnerId();
      await writeMemoryDocument(ownerId, req.relPath, renderProfileDoc(req.doc));
      const { doc, lastUpdated } = await readProfileDocAt(ownerId, req.relPath);
      reply(req.reqId, { type: 'memory.doc.result', relPath: req.relPath, doc, lastUpdated });
      broadcast({ type: 'memory.doc.changed', relPath: req.relPath });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  'memory.agentSelf.read': async (req, { reply }) => {
    try {
      const ownerId = getCurrentOwnerId();
      const content = await readAgentSelf(ownerId);
      reply(req.reqId, { type: 'memory.agentSelf.result', content });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  'memory.projectProfile.read': async (req, { reply }) => {
    try {
      const ownerId = getCurrentOwnerId();
      const profile = await readProjectProfile(ownerId, req.projectId);
      reply(req.reqId, {
        type: 'memory.projectProfile.result',
        projectId: req.projectId,
        profile,
      });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  'memory.projectList.readAll': async (req, { reply }) => {
    try {
      const ownerId = getCurrentOwnerId();
      const projects = await readAllProjectListEntriesForUI(ownerId);
      reply(req.reqId, { type: 'memory.projectList.result', projects });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  'memory.episode.readPredecessor': async (req, { reply }) => {
    try {
      const ownerId = getCurrentOwnerId();
      const ep = await readPredecessor(ownerId, req.relPath);
      let predecessor: EpisodeWithBody | null = null;
      if (ep) {
        const fname = ep.relPath.split('/').pop() ?? '';
        const fallbackTitle = fname.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
        predecessor = {
          relPath: ep.relPath,
          title: (ep.frontmatter as { title?: string }).title ?? fallbackTitle,
          date: ep.frontmatter.created ?? '',
          body: ep.body,
        };
      }
      reply(req.reqId, { type: 'memory.episode.predecessor.result', predecessor });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  // ─── 档案编辑 live 通道（Task 1）──────────────────────────────────
  'memory.doc.readLive': async (req, { reply }) => {
    try {
      const ownerId = getCurrentOwnerId();
      const abs = ensureWithinRoot(memoryRoot(ownerId), req.relPath);
      const parsed = await readMarkdownFile(abs);
      // status 对纯读无意义，仅为复用 MemoryDocLiveEvent 事件类型；消费方（editorStore.readDisk）只取 content。
      reply(req.reqId, {
        type: 'memory.doc.live',
        relPath: req.relPath,
        content: parsed?.content ?? '',
        status: 'written',
      });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
  'memory.doc.writeLive': async (req, { reply, broadcast }) => {
    try {
      const ownerId = getCurrentOwnerId();
      const res = await writeMemoryDocument(ownerId, req.relPath, req.content, {
        by: 'user',
        mark: req.mark,
        baseline: req.baseline,
        mergeOnStale: req.mergeOnStale,
      });
      reply(req.reqId, {
        type: 'memory.doc.live',
        relPath: req.relPath,
        content: res.content,
        status: res.status,
      });
      // discarded 时 commitWorkfileWrite 弃写、磁盘一字未动——不该广播，否则其他打开同档案的编辑器无谓重读。
      if (res.status !== 'discarded') broadcast({ type: 'memory.doc.changed', relPath: req.relPath });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: errMsg(e) });
    }
  },
} satisfies RegistrySlice;
