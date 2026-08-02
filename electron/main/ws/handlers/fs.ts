/**
 * fs.* 命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内 fs.* 各 case 字节级一致——纯搬运。
 * 注：handler 比 router 深一层目录，相对动态 import 路径相应多一层 `../`。
 */
import { ErrorCodes } from '@shared/types';
import type { RegistrySlice } from './types';
import { getProject, getSettings } from '../../projects/store';
import { t } from '../../i18n/t';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { listDir } from '../../fs/tree';
import { watchDir, unwatchDir } from '../../fs/watcher';
import { readMd, writeMd } from '../../fs/md';
import { hashTextFile, writeTextFile } from '../../fs/textFile';
import { ensureWithinProject } from '../../fs/projectPath';
import { registerSampling, unregisterSampling } from '../../fs/historySampler';
import { createDir, createFile } from '../../fs/createFile';
import { renameEntry, duplicateEntry, moveEntry, trashEntry } from '../../fs/mutate';
import { fileChangedEvent } from '../../fs/fsChanged';

export const fsHandlers = {
  'fs.list': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    const { entries, truncated } = await listDir(project.path, req.path);
    reply(req.reqId, {
      type: 'fs.list.result',
      projectId: req.projectId,
      path: req.path,
      entries,
      truncated: truncated || undefined,
    });
  },
  'fs.watch': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    if (req.on) watchDir(req.projectId, project.path, req.path, req.owner ?? 'tree', broadcast);
    else unwatchDir(req.projectId, req.path, req.owner ?? 'tree');
    reply(req.reqId, { type: 'ack' });
  },
  'fs.readMd': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    const content = await readMd(project.path, req.path);
    reply(req.reqId, {
      type: 'fs.md.content',
      projectId: req.projectId,
      path: req.path,
      content,
    });
  },
  'fs.writeMd': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    const result = await writeMd(project.path, req.path, req.content, {
      mark: req.mark,
      baseline: req.baseline,
      mergeOnStale: req.mergeOnStale,
    });
    // 撞同段弃写（discarded）：磁盘一字未动、不广播——由编辑器据回复开冲突卡（S27 §4/§7）。
    if (result.status === 'rejected') {
      reply(req.reqId, { type: 'fs.md.saved', projectId: req.projectId, path: req.path, result: 'discarded' });
      return;
    }
    // merged（锁内机械合并落盘）这一个布尔同时驱动两处：回复的 result（编辑器据此换入合并产物）
    // 与广播的作者标（'merged'=编辑器必换入；否则 'user'=用户落盘，自写回声按内容比对忽略）。
    const merged = result.status === 'merged';
    reply(req.reqId, {
      type: 'fs.md.saved',
      projectId: req.projectId,
      path: req.path,
      result: merged ? 'merged' : 'written',
      content: merged ? result.content : undefined,
    });
    // 带目录级 path（旧消费者收窄为只刷该目录）+ 文件级 filePath（协同接收方：你手动改 → 预览看见）
    broadcast(fileChangedEvent(req.projectId, req.path, merged ? 'merged' : 'user'));
  },
  'fs.writeText': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    const r = await writeTextFile(project.path, req.path, req.content, req.expectedDiskSha256, req.mark);
    reply(req.reqId, {
      type: 'fs.text.writeResult',
      projectId: req.projectId,
      path: req.path,
      status: r.status,
      mtimeMs: r.status === 'saved' ? r.mtimeMs : undefined,
      sha256: r.status === 'saved' ? r.sha256 : undefined,
    });
    if (r.status === 'saved') broadcast(fileChangedEvent(req.projectId, req.path));
  },
  'fs.textHash': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    const r = await hashTextFile(project.path, req.path);
    reply(req.reqId, {
      type: 'fs.text.hash',
      projectId: req.projectId,
      path: req.path,
      sha256: r.sha256,
      size: r.size,
      mtimeMs: r.mtimeMs,
    });
  },
  'fs.history.sample': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    const abs = await ensureWithinProject(project.path, req.path);
    if (req.on) registerSampling(abs);
    else unregisterSampling(abs);
    reply(req.reqId, { type: 'ack' });
  },
  'fs.writeImage': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    const docAbs = await ensureWithinProject(project.path, req.docPath);
    const { writeImageToAssets } = await import('../../fs/assetStore');
    const ref = await writeImageToAssets(
      docAbs,
      Buffer.from(req.base64, 'base64'),
      req.preferredBase,
      req.ext,
    );
    reply(req.reqId, { type: 'fs.image.written', ref });
    broadcast({ type: 'fs.changed', projectId: req.projectId }); // 新建 .assets/图 → 文件树刷新
  },
  'fs.applyTextEdit': async (req, { reply }) => {
    // 文件级文字写回（HTML 预览行内编辑落盘）：内核作用于绝对 filePath、整块入串行锁。
    // 成功只回 ack——写回是预览内已同步好的内容，绝不广播 fs.changed/indexChanged（那会触发整页 reload，
    // 把用户正在编辑的预览态打掉）。失败按 reason 分流给前端可读的降级/冲突码。
    const { applyTextEdit } = await import('../../fs/applyTextEdit');
    const r = await applyTextEdit({
      filePath: req.filePath,
      markerId: req.markerId,
      oldText: req.oldText,
      newText: req.newText,
      expectedMtimeMs: req.expectedMtimeMs,
      by: 'user', // 预览里的行内改字=用户的笔（S28 G91/G39）
      visibleMark: 'manual', // 旁路写入落盘后打可见标，时间轴上认得出、点得回（G39）
    });
    if (r.ok) {
      reply(req.reqId, { type: 'ack' });
      return;
    }
    // not-found/ambiguous=定位降级（让前端回滚 + 提示改用 AI 改写）；conflict=基线失配（提示先重载）；io→UNKNOWN
    const code =
      r.reason === 'conflict'
        ? ErrorCodes.FS_TEXT_EDIT_CONFLICT
        : r.reason === 'io'
          ? ErrorCodes.UNKNOWN
          : ErrorCodes.FS_TEXT_EDIT_DEGRADED;
    reply(req.reqId, { type: 'error', code, message: `文字写回失败：${r.reason}` });
  },
  'fs.stat': async (req, { reply }) => {
    // 绝对路径 mtime（HTML 预览就地改字的冲突基线）：与 applyTextEdit 内核同口径——
    // 绝对 filePath、Math.floor(mtimeMs)、零 project 解析。读不到（文件不存在等）回 UNKNOWN。
    const { stat } = await import('node:fs/promises');
    try {
      const s = await stat(req.filePath);
      reply(req.reqId, { type: 'fs.stat.result', filePath: req.filePath, mtimeMs: Math.floor(s.mtimeMs) });
    } catch {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: `stat 失败：${req.filePath}` });
    }
  },
  'fs.createFile': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    const r = await createFile(project.path, req.path, req.content);
    reply(req.reqId, { type: 'fs.create.result', projectId: req.projectId, path: req.path, status: r.status });
    if (r.status === 'ok') broadcast({ type: 'fs.changed', projectId: req.projectId });
  },
  'fs.mkdir': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    const r = await createDir(project.path, req.path);
    reply(req.reqId, { type: 'fs.create.result', projectId: req.projectId, path: req.path, status: r.status });
    if (r.status === 'ok') broadcast({ type: 'fs.changed', projectId: req.projectId });
  },
  'fs.rename': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    const r = await renameEntry(project.path, req.path, req.newName);
    const path = r.status === 'ok' ? r.path : req.path;
    // content 仅在 .md+assets 改名时带（回写后的新内容），供渲染端 relocate 重置内存态（§十一 C-1）
    reply(req.reqId, {
      type: 'fs.op.result',
      projectId: req.projectId,
      path,
      status: r.status,
      ...(r.status === 'ok' && r.content !== undefined ? { content: r.content } : {}),
    });
    if (r.status === 'ok') broadcast({ type: 'fs.changed', projectId: req.projectId });
  },
  'fs.duplicate': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    // 副本后缀按 owner 语言取词（en「copy」/ zh「副本」）——内核纯净，译文在边界解析后注入。
    const suffix = t('files:duplicateSuffix', resolveEffectiveLang((await getSettings()).language));
    const r = await duplicateEntry(project.path, req.path, suffix);
    const path = r.status === 'ok' ? r.path : req.path;
    reply(req.reqId, { type: 'fs.op.result', projectId: req.projectId, path, status: r.status });
    if (r.status === 'ok') broadcast({ type: 'fs.changed', projectId: req.projectId });
  },
  'fs.move': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    const r = await moveEntry(project.path, req.path, req.destDir);
    const path = r.status === 'ok' ? r.path : req.path;
    reply(req.reqId, { type: 'fs.op.result', projectId: req.projectId, path, status: r.status });
    if (r.status === 'ok') broadcast({ type: 'fs.changed', projectId: req.projectId });
  },
  'fs.trash': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    const r = await trashEntry(project.path, req.path);
    reply(req.reqId, { type: 'fs.op.result', projectId: req.projectId, path: req.path, status: r.status });
    if (r.status === 'ok') broadcast({ type: 'fs.changed', projectId: req.projectId });
  },
  'fs.reveal': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    const { ensureWithinProject } = await import('../../fs/projectPath');
    const { shell } = await import('electron');
    const abs = await ensureWithinProject(project.path, req.path);
    shell.showItemInFolder(abs);
    reply(req.reqId, { type: 'ack' });
  },
} satisfies RegistrySlice;
