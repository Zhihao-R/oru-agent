/**
 * artifact.* + HTML 标注提交命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内 artifact.* / html.* 各 case 字节级一致——纯搬运。
 * 注：handler 比 router 深一层目录，相对动态/静态 import 路径相应多一层 `../`。
 *
 * 仅本域用的模块级 helper/状态（activeExports / broadcastHtmlAnnotations /
 * broadcastHtmlSubmission）随域一并内联进本文件，不导出。
 */
import { ErrorCodes, type ChatMessage } from '@shared/types';
import { newMessageId } from '@shared/ids';
import { HTML_MSG } from '@shared/htmlProtocol';
import { promises as fs } from 'node:fs';
import type { Broadcast } from '../server';
import type { RegistrySlice } from './types';
import { errCode, errMsg } from '../errors';
import { getProject } from '../../projects/store';
import { getAgent, listAgents } from '../../agent/store/agents';
import { appendMessage, getConversation } from '../../conversations/store';
import { steeringQueue, steeringKey } from '../../agent/steeringQueue';
import { runAssembledMainTurn } from './mainTurnAssembly';
import { t } from '../../i18n/t';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { getSettings } from '../../projects/store';

/**
 * 进行中的图片版导出：artifactId → AbortController。导出起注册、终态删；
 * artifact.exportCancel 据 artifactId 找到并 abort（中断离屏渲染）。一个 deck 同时只一个导出。
 */
const activeExports = new Map<string, AbortController>();

/**
 * html 标注变化广播（项目B 第三期 Task14，护栏 C-2）——**不能**复用 deck onArtifactSubmissionChanged，
 * 其内 readAnnotations(artifactId) 是 deck 适配器、对 html 路径会抛。html 走 readAnnotationsAt(location)。
 */
async function broadcastHtmlAnnotations(htmlPath: string, broadcast: Broadcast): Promise<void> {
  const { readAnnotationsAt } = await import('../../deck/annotations');
  const { htmlAnnotationLocation } = await import('../../annotations/location');
  const annotations = await readAnnotationsAt(htmlAnnotationLocation(htmlPath));
  broadcast({ type: HTML_MSG.annotationsChanged, htmlPath, annotations });
}

/** html 提交组状态广播——活跃组用 getSubmissionView(key)，无则查崩溃「已中断」视图（与 deck discard 同口径）。 */
async function broadcastHtmlSubmission(htmlPath: string, broadcast: Broadcast): Promise<void> {
  const { getSubmissionView, getInterruptedViewFor } = await import('../../deck/submissions');
  const { htmlTarget } = await import('../../submissions/target');
  const target = htmlTarget(htmlPath); // key=resolve(htmlPath)：活跃组查询与崩溃视图同源
  const submission = getSubmissionView(target.key) ?? (await getInterruptedViewFor(target));
  broadcast({ type: HTML_MSG.submissionChanged, htmlPath, submission });
}

export const artifactHandlers = {
  // ─── Deck 模块（v1）─────────────────────────────────────────
  'artifact.list': async (req, { reply }) => {
    const { listDecks, getActiveDeckId } = await import('../../deck/store');
    const decks = await listDecks(req.projectId);
    reply(req.reqId, {
      type: 'artifact.list.result',
      projectId: req.projectId,
      decks,
      activeArtifactId: getActiveDeckId(),
    });
  },
  'artifact.adopt': async (req, { reply, broadcast }) => {
    // deck 找回 §3.2：收编现有文件夹为 deck（纯登记，不动原件）。
    try {
      const project = await getProject(req.projectId);
      const { join, basename } = await import('node:path');
      const { promises: nodeFs } = await import('node:fs');
      const { segmentSlides } = await import('../../deck/deckModel');
      const { isWithin } = await import('../../agent/agentTools/pathSandbox');
      const absPath = join(project.path, req.path);
      // 校验在项目下——复用沙箱的 isWithin（挡 ../sibling 逃逸；与 agent 写盘同一把尺）
      if (!isWithin(absPath, project.path)) {
        reply(req.reqId, { type: 'artifact.adopt.result', ok: false, message: '路径不在项目内' });
        return;
      }
      // 二次确认是 deck（防前端误传 dist 之类）；真值源仍是渲染端探针，此处只预筛
      let html: string;
      try {
        html = await nodeFs.readFile(join(absPath, 'index.html'), 'utf-8');
      } catch {
        reply(req.reqId, { type: 'artifact.adopt.result', ok: false, message: '该文件夹没有 index.html，不是演示稿' });
        return;
      }
      if (segmentSlides(html).length < 1) {
        reply(req.reqId, { type: 'artifact.adopt.result', ok: false, message: '该文件夹翻不出页，不是演示稿' });
        return;
      }
      const { registerExistingDeck, setActiveDeckId, listDecks } = await import('../../deck/store');
      const record = await registerExistingDeck({
        projectId: req.projectId,
        name: basename(absPath),
        path: absPath,
      });
      setActiveDeckId(record.id);
      reply(req.reqId, { type: 'artifact.adopt.result', ok: true, artifactId: record.id });
      const decks = await listDecks(req.projectId);
      broadcast({ type: 'artifact.state', projectId: req.projectId, decks, activeArtifactId: record.id });
    } catch (e) {
      reply(req.reqId, { type: 'artifact.adopt.result', ok: false, message: errMsg(e) });
    }
  },
  'artifact.activate': async (req, { reply, broadcast }) => {
    const { setActiveDeckId, getDeck } = await import('../../deck/store');
    if (req.artifactId !== null) {
      // 验证 deck 存在
      const deck = await getDeck(req.artifactId);
      if (!deck) {
        reply(req.reqId, {
          type: 'error',
          code: ErrorCodes.DECK_NOT_FOUND,
          message: `deck not found: ${req.artifactId}`,
        });
        return;
      }
    }
    setActiveDeckId(req.artifactId);
    reply(req.reqId, { type: 'ack' });
    // 广播新 active
    if (req.artifactId !== null) {
      const { listDecks, getDeck: getDeck2 } = await import('../../deck/store');
      const deck = await getDeck2(req.artifactId);
      if (deck) {
        const decks = await listDecks(deck.projectId);
        broadcast({
          type: 'artifact.state',
          projectId: deck.projectId,
          decks,
          activeArtifactId: req.artifactId,
        });
      }
      // 项目B 第一期：deck 首次在新代码下打开时一次性迁移 .history → 中央仓（幂等 + sentinel）。
      // 失败兜底——吞错不破坏 activate，该 deck 自动退回 legacy 读路径（snapshotId 缺失即读 vNNN.html），
      // 下次打开重试（生死线-2「旧数据不丢」）。
      try {
        const { migrateDeckIfNeeded } = await import('../../deck/historyMigration');
        await migrateDeckIfNeeded(req.artifactId);
      } catch (e) {
        console.warn(`[deck.migration] migrate failed for ${req.artifactId}, fallback to legacy:`, e);
      }
      // 崩溃兜底（设计 §6.6）：加载时把孤儿 submitted 标注降回 pending，避免带失效
      // groupId 永久卡住。
      const { reconcileOrphanedSubmissions, getInterruptedView } = await import('../../deck/submissions');
      const { readAnnotations } = await import('../../deck/annotations');
      await reconcileOrphanedSubmissions(req.artifactId);
      // 进入 deck 时前端 annotations store 为空——activate 必须主动推一次当前批注做首屏，
      // 否则要等到下次 add/update 广播历史批注才显现。reconcile 之后读，反映降级后状态。
      const annotations = await readAnnotations(req.artifactId);
      broadcast({ type: 'artifact.annotationsChanged', artifactId: req.artifactId, annotations });
      // 崩溃「已中断」（PRD §六-6）：进程刚起无 live 组，若有中断记录则推「已中断」视图，
      // 前端据此渲染「继续」/「退回改前」（无则 null，前端无活跃组 UI）。
      const interrupted = await getInterruptedView(req.artifactId);
      broadcast({ type: 'artifact.submissionChanged', artifactId: req.artifactId, submission: interrupted });
      // 同属崩溃兜底：对比临时文件（.compare-*.html）只在内存对比态期间存在，
      // 若上次会话在对比中崩溃/退出会残留——加载时一并清掉，与孤儿降级对称。
      const { cleanupCompare } = await import('../../deck/compare');
      await cleanupCompare(req.artifactId);
    }
  },
  'artifact.addAnnotation': async (req, { reply, broadcast }) => {
    try {
      const { addAnnotation, readAnnotations } = await import('../../deck/annotations');
      await addAnnotation(req.artifactId, { ...req.annotation, cropPng: req.cropPngBase64 });
      reply(req.reqId, { type: 'ack' });
      const annotations = await readAnnotations(req.artifactId);
      broadcast({ type: 'artifact.annotationsChanged', artifactId: req.artifactId, annotations });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.updateAnnotation': async (req, { reply, broadcast }) => {
    try {
      const { updateAnnotation, readAnnotations } = await import('../../deck/annotations');
      await updateAnnotation(req.artifactId, req.annotationId, req.patch);
      reply(req.reqId, { type: 'ack' });
      const annotations = await readAnnotations(req.artifactId);
      broadcast({ type: 'artifact.annotationsChanged', artifactId: req.artifactId, annotations });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.removeAnnotation': async (req, { reply, broadcast }) => {
    try {
      const { removeAnnotation, readAnnotations } = await import('../../deck/annotations');
      await removeAnnotation(req.artifactId, req.annotationId);
      reply(req.reqId, { type: 'ack' });
      const annotations = await readAnnotations(req.artifactId);
      broadcast({ type: 'artifact.annotationsChanged', artifactId: req.artifactId, annotations });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.submitAnnotations': async (req, { reply, broadcast }) => {
    try {
      const { submitAnnotations, getSubmissionView } = await import('../../deck/submissions');
      const { readAnnotations } = await import('../../deck/annotations');
      const r = await submitAnnotations({
        artifactId: req.artifactId,
        annotationIds: req.annotationIds,
        conversationId: req.conversationId,
      });
      reply(req.reqId, {
        type: 'artifact.submitAnnotations.result',
        artifactId: req.artifactId,
        ok: true,
        groupId: r.groupId,
        beforeVersionId: r.beforeVersionId,
        payload: r.payload,
      });
      // 乐观成组：广播 annotationsChanged，前端把这批置顶为「修改中」组
      const annotations = await readAnnotations(req.artifactId);
      broadcast({ type: 'artifact.annotationsChanged', artifactId: req.artifactId, annotations });
      broadcast({ type: 'artifact.submissionChanged', artifactId: req.artifactId, submission: getSubmissionView(req.artifactId) });
    } catch (e) {
      const err = e as Error & { code?: string };
      // 并发约束拒绝 → ok:false 让前端禁用提交并提示；其余走通用 error
      if (err.code === 'ARTIFACT_SUBMISSION_IN_PROGRESS') {
        reply(req.reqId, {
          type: 'artifact.submitAnnotations.result',
          artifactId: req.artifactId,
          ok: false,
          message: '上一组还在修改中，先完成或停止修改后再提交',
        });
        return;
      }
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.updateFromNarrative': async (req, { reply, broadcast }) => {
    // 据当前文稿更新这份演示设计——一次提交：建组 → 主对话据文稿全文手术式改
    // index.html → AI 调 artifact_finalize_submission 收尾。决策 D-A：整篇文稿喂模型但不刷屏、
    // 不进 history，对话里只留 userText 一行进度，文稿全文塞进 extraDynamicSystemPrompt（每轮现拼）。
    try {
      const { submitAnnotations, getSubmissionView } = await import('../../deck/submissions');
      const { readAnnotations } = await import('../../deck/annotations');
      const { resolveDeckPath } = await import('../../deck/store');
      const { deckNarrativePath, deckIndexPath } = await import('../../deck/pathResolver');

      // 焦点提交组挂在 conversationId 上，agent 由服务端按 active 解析（对齐 maybeResumeTurn）。
      const { activeId } = await listAgents();
      if (!activeId) {
        reply(req.reqId, { type: 'error', code: ErrorCodes.AGENT_NOT_FOUND, message: '无活跃 Twin，无法据文稿更新' });
        return;
      }

      // G11 收编：本入口起的是主对话回合，必须过准入闸（此前直调 runChatAndPersist 绕闸，
      // 忙时互撞 AGENT_BUSY——整体验收实测）。占闸在建组之前：忙时不建组，否则组建了却派不出轮，
      // 留「修改中」孤儿组阻塞后续提交。忙时如实回执请用户稍后再点（PM 2026-07-13 拍板，不排队）。
      // 取 activeId 后立即占闸（await 后重检铁律：中间不隔别的 await，key/agent/conversation/落盘
      // 全部绑定同一个 activeId 快照——点击时刻的活跃 Twin）；取数挪进闸后 try，失败必释放闸。
      const key = steeringKey(activeId, req.conversationId);
      const turnToken = await steeringQueue.beginDirectTurn(key);
      if (turnToken == null) {
        const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
        reply(req.reqId, {
          type: 'artifact.submitAnnotations.result',
          artifactId: req.artifactId,
          ok: false,
          message: t('main:artifact.updateBusyWhileRunning', lang),
        });
        return;
      }
      try {
        // 先取 agent/conversation 再建组——缺失时组不建，不留"修改中"孤儿组阻塞后续提交。
        const agent = await getAgent(activeId);
        const conversation = await getConversation(activeId, req.conversationId);
        const deckPath = await resolveDeckPath(req.artifactId);
        // 文稿全文（为空/占位也照常喂，让模型据空文稿处理——实际极少，不特判）
        const narrative = await fs.readFile(deckNarrativePath(deckPath), 'utf-8').catch(() => '');

        // includeAnnotations：连该 deck 所有 pending 标注一并改 → 并入组；否则纯文稿更新（空组）
        const annIds = req.includeAnnotations
          ? (await readAnnotations(req.artifactId)).filter((a) => a.status === 'pending').map((a) => a.id)
          : [];

        // 建组（拿 groupId）——并发约束在此守住，已有未完成组抛 ARTIFACT_SUBMISSION_IN_PROGRESS
        const { groupId } = await submitAnnotations({
          artifactId: req.artifactId,
          annotationIds: annIds,
          conversationId: req.conversationId,
        });
        const annotations = await readAnnotations(req.artifactId);
        broadcast({ type: 'artifact.annotationsChanged', artifactId: req.artifactId, annotations });
        broadcast({ type: 'artifact.submissionChanged', artifactId: req.artifactId, submission: getSubmissionView(req.artifactId) });

        // 派发主对话一轮：userText 是干净一行（落盘 + 显示），技术料全进 extraDynamicSystemPrompt
        const userMsgId = newMessageId();
        const userText = '据当前文稿更新这份演示设计';
        const extraDynamicSystemPrompt = [
          `# 据当前文稿更新这份演示设计（提交组 ${groupId}）`,
          '',
          `读 \`${deckIndexPath(deckPath)}\`，据下面的叙事文稿手术式改写后写回：只改文稿牵涉处，` +
            '保留 deck 既有视觉与结构和用户既有的直接改动；改动可能遍及多页，别预判页码。',
          '',
          `改完调 \`artifact_finalize_submission\`（group_id=${groupId}），并在其 \`summary\` 参数里用 ` +
            '1-2 句概述本次文稿变更重点；若据文稿其实无需改动 index.html，也照常调收尾工具——它会自动撤销空更新。',
          '',
          '## 本次更新依据的叙事文稿',
          '',
          narrative,
        ].join('\n');

        const userMsg: ChatMessage = {
          id: userMsgId,
          conversationId: req.conversationId,
          role: 'user',
          text: userText,
          toolCalls: [],
          createdAt: Date.now(),
          done: true,
        };
        await appendMessage(activeId, req.conversationId, userMsg);
        reply(req.reqId, { type: 'ack' });

        // 刻意不调 dreamOnUserMessage()：本路径 userText 是装配给模型的文稿，非用户自由输入。
        // capture 触发不再由写入点手动驱动（已收口到 runChatAndPersist 落 assistant 那刻从历史数轮次），
        // 故本条消息会随历史被计入一轮——取舍见重构 plan 风险 1（多触发一次会自跳过的 capture，无害）。
        // 统一回合装配（chat.started 由它广播）：占了闸的回合由回合循环负责 concludeTurn 释放，
        // 期间入队的用户消息回合末合并续跑，不再互撞。
        void runAssembledMainTurn({
          agentId: activeId,
          agent,
          conversation,
          broadcast,
          runToken: turnToken,
          firstText: userText,
          extraDynamicSystemPrompt,
        });
      } catch (e) {
        // 占闸后的任何失败（建组冲突、读盘、落盘）都必须释放闸，否则对话永久卡「运行中」——
        // 按 token 归属释放（§6），不误清 await 间隙里可能已起的新回合；释放后原样上抛交外层统一回执。
        await steeringQueue.handBackIfRunning(key, turnToken);
        throw e;
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      // 并发约束拒绝 → ok:false 让前端禁用并提示（与 submitAnnotations handler 一致）
      if (err.code === 'ARTIFACT_SUBMISSION_IN_PROGRESS') {
        reply(req.reqId, {
          type: 'artifact.submitAnnotations.result',
          artifactId: req.artifactId,
          ok: false,
          message: '上一组还在修改中，先完成或停止修改后再更新',
        });
        return;
      }
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.manualFinalize': async (req, { reply, broadcast }) => {
    try {
      const { finalizeSubmission, getSubmissionView } = await import('../../deck/submissions');
      const { readAnnotations } = await import('../../deck/annotations');
      // 手动完成：results 空 = 全成功
      await finalizeSubmission(req.groupId, {});
      reply(req.reqId, { type: 'ack' });
      const annotations = await readAnnotations(req.artifactId);
      broadcast({ type: 'artifact.annotationsChanged', artifactId: req.artifactId, annotations });
      broadcast({ type: 'artifact.submissionChanged', artifactId: req.artifactId, submission: getSubmissionView(req.artifactId) });
      broadcast({ type: 'artifact.indexChanged', artifactId: req.artifactId });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.stopSubmission': async (req, { reply, broadcast }) => {
    try {
      const { stopSubmission, getSubmissionView } = await import('../../deck/submissions');
      const { readAnnotations } = await import('../../deck/annotations');
      await stopSubmission(req.groupId);
      reply(req.reqId, { type: 'ack' });
      const annotations = await readAnnotations(req.artifactId);
      broadcast({ type: 'artifact.annotationsChanged', artifactId: req.artifactId, annotations });
      broadcast({ type: 'artifact.submissionChanged', artifactId: req.artifactId, submission: getSubmissionView(req.artifactId) });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.enterCompare': async (req, { reply }) => {
    try {
      const { getByGroup } = await import('../../deck/submissions');
      const { prepareCompare } = await import('../../deck/compare');
      const sub = getByGroup(req.groupId);
      if (!sub || sub.afterVersionId === undefined) {
        // 前端只在「完成」组渲染「对比」按钮，正常不会走到这——这是不信前端的后端兜底，
        // 故用通用 UNKNOWN 即可，不为这个 UI 已拦的状态单设语义错误码（克制）。
        reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: '组未完成不能对比' });
        return;
      }
      const { beforeFile, afterFile } = await prepareCompare(
        req.artifactId,
        sub.beforeVersionId,
        sub.afterVersionId,
      );
      // 不广播：对比是只读临时态
      reply(req.reqId, { type: 'artifact.enterCompare.result', beforeFile, afterFile });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.exitCompare': async (req, { reply }) => {
    try {
      const { cleanupCompare } = await import('../../deck/compare');
      await cleanupCompare(req.artifactId);
      reply(req.reqId, { type: 'ack' });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },

  // ─── HTML 标注提交（项目B 第三期 Task14）──────────────────────────────
  // 与 artifact.* 对称：解析 htmlTarget(htmlPath) 喂共用内核，广播走独立 html.*（C-2）。
  // 松散 html 不套 artifactId、不跑 deck 体检（resolveDeckPath/validateDeck 对它会抛）。
  [HTML_MSG.activate]: async (req, { reply }) => {
    try {
      // 打开 html 预览时拉一次 sidecar 标注 + 提交组视图（deck 由 artifact.activate 触发）。
      // 顺带 reconcile 孤儿组（崩溃降级/「已中断」派生），同 deck activate 口径。
      const { reconcileOrphanedFor, getSubmissionView, getInterruptedViewFor } = await import(
        '../../deck/submissions'
      );
      const { htmlTarget } = await import('../../submissions/target');
      const { readAnnotationsAt } = await import('../../deck/annotations');
      const { htmlAnnotationLocation } = await import('../../annotations/location');
      const { cleanupCompareFor } = await import('../../deck/compare');
      const target = htmlTarget(req.htmlPath);
      await cleanupCompareFor(target); // 清上次会话对比态崩溃残留的临时快照（同 deck activate）
      await reconcileOrphanedFor(target);
      const annotations = await readAnnotationsAt(htmlAnnotationLocation(req.htmlPath));
      const submission =
        getSubmissionView(target.key) ?? (await getInterruptedViewFor(target));
      reply(req.reqId, {
        type: HTML_MSG.activateResult,
        htmlPath: req.htmlPath,
        annotations,
        submission,
      });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  [HTML_MSG.addAnnotation]: async (req, { reply, broadcast }) => {
    try {
      const { addAnnotationAt } = await import('../../deck/annotations');
      const { htmlAnnotationLocation } = await import('../../annotations/location');
      await addAnnotationAt(htmlAnnotationLocation(req.htmlPath), {
        ...req.annotation,
        cropPng: req.cropPngBase64,
      });
      reply(req.reqId, { type: 'ack' });
      await broadcastHtmlAnnotations(req.htmlPath, broadcast);
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  [HTML_MSG.updateAnnotation]: async (req, { reply, broadcast }) => {
    try {
      const { updateAnnotationAt } = await import('../../deck/annotations');
      const { htmlAnnotationLocation } = await import('../../annotations/location');
      await updateAnnotationAt(htmlAnnotationLocation(req.htmlPath), req.annotationId, req.patch);
      reply(req.reqId, { type: 'ack' });
      await broadcastHtmlAnnotations(req.htmlPath, broadcast);
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  [HTML_MSG.removeAnnotation]: async (req, { reply, broadcast }) => {
    try {
      const { removeAnnotationAt } = await import('../../deck/annotations');
      const { htmlAnnotationLocation } = await import('../../annotations/location');
      await removeAnnotationAt(htmlAnnotationLocation(req.htmlPath), req.annotationId);
      reply(req.reqId, { type: 'ack' });
      await broadcastHtmlAnnotations(req.htmlPath, broadcast);
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  [HTML_MSG.submitAnnotations]: async (req, { reply, broadcast }) => {
    try {
      const { submitAnnotationsTo } = await import('../../deck/submissions');
      const { htmlTarget } = await import('../../submissions/target');
      const r = await submitAnnotationsTo(
        htmlTarget(req.htmlPath),
        req.annotationIds,
        req.conversationId,
      );
      reply(req.reqId, {
        type: HTML_MSG.submitAnnotationsResult,
        htmlPath: req.htmlPath,
        ok: true,
        groupId: r.groupId,
        beforeVersionId: r.beforeVersionId,
        payload: r.payload,
      });
      await broadcastHtmlAnnotations(req.htmlPath, broadcast);
      await broadcastHtmlSubmission(req.htmlPath, broadcast);
    } catch (e) {
      const err = e as Error & { code?: string };
      // 并发约束拒绝 → ok:false 让前端禁用提交并提示（与 deck 对称）
      if (err.code === 'ARTIFACT_SUBMISSION_IN_PROGRESS') {
        reply(req.reqId, {
          type: HTML_MSG.submitAnnotationsResult,
          htmlPath: req.htmlPath,
          ok: false,
          message: '上一组还在修改中，先完成或停止修改后再提交',
        });
        return;
      }
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  [HTML_MSG.manualFinalize]: async (req, { reply, broadcast }) => {
    try {
      // C-1：html 收尾直调核心 finalizeSubmission(groupId)，不经 deck agentTool（含 validateDeck 等 deck 专属）
      const { finalizeSubmission } = await import('../../deck/submissions');
      await finalizeSubmission(req.groupId, {});
      reply(req.reqId, { type: 'ack' });
      await broadcastHtmlAnnotations(req.htmlPath, broadcast);
      await broadcastHtmlSubmission(req.htmlPath, broadcast);
      broadcast({ type: HTML_MSG.indexChanged, htmlPath: req.htmlPath });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  [HTML_MSG.stopSubmission]: async (req, { reply, broadcast }) => {
    try {
      const { stopSubmission } = await import('../../deck/submissions');
      await stopSubmission(req.groupId);
      reply(req.reqId, { type: 'ack' });
      await broadcastHtmlAnnotations(req.htmlPath, broadcast);
      await broadcastHtmlSubmission(req.htmlPath, broadcast);
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  [HTML_MSG.saveSubmission]: async (req, { reply, broadcast }) => {
    try {
      const { saveSubmission } = await import('../../deck/submissions');
      const { cleanupCompareFor } = await import('../../deck/compare');
      const { htmlTarget } = await import('../../submissions/target');
      await saveSubmission(req.groupId);
      await cleanupCompareFor(htmlTarget(req.htmlPath)); // 防对比临时文件残留
      reply(req.reqId, { type: 'ack' });
      await broadcastHtmlAnnotations(req.htmlPath, broadcast);
      // 不广播 indexChanged：保存接受改后态，文件未变
      await broadcastHtmlSubmission(req.htmlPath, broadcast);
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  [HTML_MSG.cancelSubmission]: async (req, { reply, broadcast }) => {
    try {
      const { cancelSubmission } = await import('../../deck/submissions');
      const { cleanupCompareFor } = await import('../../deck/compare');
      const { htmlTarget } = await import('../../submissions/target');
      await cancelSubmission(req.groupId);
      await cleanupCompareFor(htmlTarget(req.htmlPath));
      reply(req.reqId, { type: 'ack' });
      await broadcastHtmlAnnotations(req.htmlPath, broadcast);
      await broadcastHtmlSubmission(req.htmlPath, broadcast);
      broadcast({ type: HTML_MSG.indexChanged, htmlPath: req.htmlPath }); // checkout 改了 html → 热重载回改前
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  [HTML_MSG.discardInterrupted]: async (req, { reply, broadcast }) => {
    try {
      // 「退回改前」（崩溃中断组，PRD §六-6）
      const { discardInterruptedFor } = await import('../../deck/submissions');
      const { cleanupCompareFor } = await import('../../deck/compare');
      const { htmlTarget } = await import('../../submissions/target');
      await discardInterruptedFor(htmlTarget(req.htmlPath), req.groupId);
      await cleanupCompareFor(htmlTarget(req.htmlPath));
      reply(req.reqId, { type: 'ack' });
      await broadcastHtmlAnnotations(req.htmlPath, broadcast);
      await broadcastHtmlSubmission(req.htmlPath, broadcast);
      broadcast({ type: HTML_MSG.indexChanged, htmlPath: req.htmlPath });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  [HTML_MSG.enterCompare]: async (req, { reply }) => {
    try {
      const { getByGroup } = await import('../../deck/submissions');
      const { prepareCompareFor } = await import('../../deck/compare');
      const { htmlTarget } = await import('../../submissions/target');
      const sub = getByGroup(req.groupId);
      if (!sub || sub.afterVersionId === undefined) {
        reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: '组未完成不能对比' });
        return;
      }
      const { beforeFile, afterFile } = await prepareCompareFor(
        htmlTarget(req.htmlPath),
        sub.beforeVersionId,
        sub.afterVersionId,
      );
      // 不广播：对比是只读临时态
      reply(req.reqId, { type: HTML_MSG.enterCompareResult, beforeFile, afterFile });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  [HTML_MSG.exitCompare]: async (req, { reply }) => {
    try {
      const { cleanupCompareFor } = await import('../../deck/compare');
      const { htmlTarget } = await import('../../submissions/target');
      await cleanupCompareFor(htmlTarget(req.htmlPath));
      reply(req.reqId, { type: 'ack' });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.saveSubmission': async (req, { reply, broadcast }) => {
    try {
      const { saveSubmission, getSubmissionView } = await import('../../deck/submissions');
      const { cleanupCompare } = await import('../../deck/compare');
      const { readAnnotations } = await import('../../deck/annotations');
      await saveSubmission(req.groupId);
      await cleanupCompare(req.artifactId);  // 防对比临时文件残留
      reply(req.reqId, { type: 'ack' });
      const annotations = await readAnnotations(req.artifactId);
      broadcast({ type: 'artifact.annotationsChanged', artifactId: req.artifactId, annotations });
      // 不广播 indexChanged：保存接受改后态，文件未变
      broadcast({ type: 'artifact.submissionChanged', artifactId: req.artifactId, submission: getSubmissionView(req.artifactId) });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.cancelSubmission': async (req, { reply, broadcast }) => {
    try {
      const { cancelSubmission, getSubmissionView } = await import('../../deck/submissions');
      const { cleanupCompare } = await import('../../deck/compare');
      const { readAnnotations } = await import('../../deck/annotations');
      await cancelSubmission(req.groupId);
      await cleanupCompare(req.artifactId);
      reply(req.reqId, { type: 'ack' });
      const annotations = await readAnnotations(req.artifactId);
      broadcast({ type: 'artifact.annotationsChanged', artifactId: req.artifactId, annotations });
      broadcast({ type: 'artifact.submissionChanged', artifactId: req.artifactId, submission: getSubmissionView(req.artifactId) });
      // cancel checkout 改了 index.html → hot reload 回改前
      broadcast({ type: 'artifact.indexChanged', artifactId: req.artifactId });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.discardInterrupted': async (req, { reply, broadcast }) => {
    try {
      // 「退回改前」（崩溃中断组，PRD §六-6）：checkout beforeVersion、标注降级、清记录
      const { discardInterruptedGroup, getSubmissionView, getInterruptedView } = await import('../../deck/submissions');
      const { cleanupCompare } = await import('../../deck/compare');
      const { readAnnotations } = await import('../../deck/annotations');
      await discardInterruptedGroup(req.artifactId, req.groupId);
      await cleanupCompare(req.artifactId);
      reply(req.reqId, { type: 'ack' });
      const annotations = await readAnnotations(req.artifactId);
      broadcast({ type: 'artifact.annotationsChanged', artifactId: req.artifactId, annotations });
      // 退回后既无 live 组也无中断记录 → 视图归 null（getSubmissionView 兜底空，再查中断也为空）
      const submission = getSubmissionView(req.artifactId) ?? (await getInterruptedView(req.artifactId));
      broadcast({ type: 'artifact.submissionChanged', artifactId: req.artifactId, submission });
      broadcast({ type: 'artifact.indexChanged', artifactId: req.artifactId }); // checkout 改了 index.html
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.applyInlineEdit': async (req, { reply, broadcast }) => {
    try {
      const { applyInlineEdit } = await import('../../deck/applyInlineEdit');
      const r = await applyInlineEdit({
        artifactId: req.artifactId,
        markerId: req.markerId,
        oldText: req.oldText,
        newText: req.newText,
        pageIndex: req.pageIndex,
      });
      if (!r.ok) {
        // 定位降级（找不到 / 歧义）统一用一个 code——前端据此回滚 DOM + 提示框选交给 AI
        const degraded = r.reason === 'not-found' || r.reason === 'ambiguous';
        reply(req.reqId, {
          type: 'error',
          code: degraded ? ErrorCodes.DECK_INLINE_EDIT_DEGRADED : ErrorCodes.UNKNOWN,
          message: r.message,
        });
        return;
      }
      reply(req.reqId, { type: 'ack' });
      broadcast({ type: 'artifact.indexChanged', artifactId: req.artifactId });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.listHistory': async (req, { reply }) => {
    try {
      const { listVersions, readManifest } = await import('../../deck/history');
      const versions = await listVersions(req.artifactId);
      const manifest = await readManifest(req.artifactId);
      reply(req.reqId, {
        type: 'artifact.listHistory.result',
        artifactId: req.artifactId,
        versions,
        currentVersion: manifest?.currentVersion ?? '',
      });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.historyPreview': async (req, { reply }) => {
    try {
      const { buildHistoryContactSheet } = await import('../../deck/contactSheet');
      const r = await buildHistoryContactSheet(req.artifactId, req.versionId);
      reply(req.reqId, {
        type: 'artifact.historyPreview.result',
        artifactId: req.artifactId,
        versionId: req.versionId,
        sheetImages: r.sheetImages,
        pageCount: r.pageCount,
      });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.checkoutHistory': async (req, { reply, broadcast }) => {
    try {
      const { checkoutVersion } = await import('../../deck/history');
      const { flushPending } = await import('../../deck/commitScheduler');
      const { isDirty, commitVersion } = await import('../../deck/history');
      // 防护性 commit：切版本前如果 dirty 先落一版
      await flushPending(req.artifactId);
      if (await isDirty(req.artifactId)) {
        await commitVersion(req.artifactId, 'protective', '切到旧版本前的暂存');
      }
      const r = await checkoutVersion(req.artifactId, req.versionId, { force: req.force });
      if (!r.ok) {
        reply(req.reqId, {
          type: 'artifact.checkoutHistory.result',
          ok: false,
          missingImages: r.missingImages,
        });
        return;
      }
      reply(req.reqId, { type: 'artifact.checkoutHistory.result', ok: true });
      // checkout 改了 index.html → 触发 hot reload
      broadcast({ type: 'artifact.indexChanged', artifactId: req.artifactId });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.export': async (req, { reply, broadcast }) => {
    // 图片版导出可被取消：注册 AbortController（按 artifactId），signal 透传到离屏渲染；
    // artifact.exportCancel 据此 abort。html 导出快、无需取消，但统一走同一注册（终态删）。
    const controller = new AbortController();
    activeExports.set(req.artifactId, controller);
    try {
      const { resolveDeckPath } = await import('../../deck/store');
      const deckPath = await resolveDeckPath(req.artifactId);
      // 图片版导出（pdf/pptx）的清晰度与逐页进度：scale 透传成 deviceScaleFactor，
      // onProgress 按页广播给前端导出 UI（按 artifactId 关联）。
      const imageExportOpts = {
        deviceScaleFactor: req.scale ?? 1,
        onProgress: (done: number, total: number) =>
          broadcast({ type: 'artifact.export.progress', artifactId: req.artifactId, done, total }),
      };
      let path: string;
      switch (req.format) {
        case 'html-inline': {
          const { exportDeckToInlineHtml } = await import('../../deck/exportHtml');
          path = await exportDeckToInlineHtml(deckPath);
          break;
        }
        case 'html-zip': {
          const { exportDeckToZip } = await import('../../deck/exportHtml');
          path = await exportDeckToZip(deckPath);
          break;
        }
        case 'pdf': {
          const { exportDeckToPdf } = await import('../../deck/exportPdf');
          path = await exportDeckToPdf(deckPath, controller.signal, imageExportOpts);
          break;
        }
        case 'pptx': {
          const { exportDeckToPptx } = await import('../../deck/exportPptx');
          path = await exportDeckToPptx(deckPath, controller.signal, imageExportOpts);
          break;
        }
        default: {
          // 穷尽校验：handler 里 req 已窄化到单一 artifact.export 成员，req.format 在 default 即 never（断言它而非整 req——
          // 整 req 在逐 type handler 签名下不会因 format 穷尽而收窄到 never，这是与原 router 联合 switch 上下文的唯一差异）。
          const _exhaustive: never = req.format;
          throw new Error(`未知导出格式: ${String(_exhaustive)}`);
        }
      }
      const { shell } = await import('electron');
      shell.showItemInFolder(path); // 导出完成在访达高亮，用户立刻拿到
      reply(req.reqId, { type: 'artifact.export.result', ok: true, path });
    } catch (e) {
      // abort 走的也是抛错路径——区分"用户取消"与真失败，前端据 cancelled 关弹窗不报错。
      const cancelled = controller.signal.aborted;
      reply(req.reqId, {
        type: 'artifact.export.result',
        ok: false,
        cancelled,
        message: cancelled ? '已取消导出' : errMsg(e),
      });
    } finally {
      activeExports.delete(req.artifactId);
    }
  },
  'artifact.exportCancel': async (req, { reply }) => {
    activeExports.get(req.artifactId)?.abort(); // 中断离屏渲染；进行中的 export 走 catch→cancelled
    reply(req.reqId, { type: 'ack' });
  },
  'artifact.undo': async (req, { reply, broadcast }) => {
    try {
      const { peekUndo, undo } = await import('../../deck/undoStack');
      const { applyUndo } = await import('../../deck/applyUndoRedo');
      const { readAnnotations } = await import('../../deck/annotations');
      const entry = peekUndo(req.artifactId);
      if (!entry) {
        // 栈空 或 撞到 barrier——前端按 reply ack 后 toast 提示用户
        reply(req.reqId, { type: 'ack' });
        return;
      }
      const r = await applyUndo(req.artifactId, entry);
      if (!r.ok) {
        reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: r.reason });
        return;
      }
      undo(req.artifactId);  // peek 成功 + apply 成功 → 真消费栈
      reply(req.reqId, { type: 'ack' });
      if (r.needIndexReload) broadcast({ type: 'artifact.indexChanged', artifactId: req.artifactId });
      if (r.needAnnotationsReload) {
        const annotations = await readAnnotations(req.artifactId);
        broadcast({ type: 'artifact.annotationsChanged', artifactId: req.artifactId, annotations });
      }
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.redo': async (req, { reply, broadcast }) => {
    try {
      const { peekRedo, redo } = await import('../../deck/undoStack');
      const { applyRedo } = await import('../../deck/applyUndoRedo');
      const { readAnnotations } = await import('../../deck/annotations');
      const entry = peekRedo(req.artifactId);
      if (!entry) {
        reply(req.reqId, { type: 'ack' });
        return;
      }
      const r = await applyRedo(req.artifactId, entry);
      if (!r.ok) {
        reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: r.reason });
        return;
      }
      redo(req.artifactId);
      reply(req.reqId, { type: 'ack' });
      if (r.needIndexReload) broadcast({ type: 'artifact.indexChanged', artifactId: req.artifactId });
      if (r.needAnnotationsReload) {
        const annotations = await readAnnotations(req.artifactId);
        broadcast({ type: 'artifact.annotationsChanged', artifactId: req.artifactId, annotations });
      }
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'artifact.reorderSlides': async (req, { reply, broadcast }) => {
    try {
      const { reorderSlides } = await import('../../deck/reorderSlides');
      const r = await reorderSlides({
        artifactId: req.artifactId,
        newOrder: req.newOrder,
        broadcast,
      });
      if (!r.ok) {
        reply(req.reqId, { type: 'error', code: r.code, message: r.message });
        return;
      }
      reply(req.reqId, { type: 'ack' });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },

  'artifact.generateDeck': async (req, { reply, broadcast }) => {
    try {
      const { getDeck } = await import('../../deck/store');
      const deck = await getDeck(req.artifactId);
      if (!deck) {
        reply(req.reqId, {
          type: 'error',
          code: ErrorCodes.DECK_NOT_FOUND,
          message: `deck not found: ${req.artifactId}`,
        });
        return;
      }
      const { generateDeckForArtifact } = await import('../../deck/dispatchSubagent');
      const r = await generateDeckForArtifact({
        deck,
        conversationId: req.conversationId,
        broadcast,
      });
      if (!r.ok) {
        reply(req.reqId, {
          type: 'error',
          code: r.reason === 'busy' ? ErrorCodes.TASK_BUSY : ErrorCodes.UNKNOWN,
          message: r.message,
        });
        return;
      }
      reply(req.reqId, { type: 'ack' });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
} satisfies RegistrySlice;
