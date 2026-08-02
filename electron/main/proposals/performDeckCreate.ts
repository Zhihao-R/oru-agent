/**
 * Deck 模块 v1：deck.create proposal 接受后执行（纯执行——状态迁移由调用方统一收尾）。
 *
 * 流程（详 tech doc §9.3）：
 * 1. 校验 targetProjectId
 * 2. createDeck（含 sanitize / 重名 / 建目录 / 注册 + 存 deckSkillId）+ initManifest 写 stub
 *    + 把提案带来的叙事文稿写进 .narrative.md（空串才回退占位）
 * 3. setActiveDeckId + 广播 deck.state（前端切 4 列布局）
 * 4. 仅 proposal.autoGenerate 时 dispatchDeckSubagent 派 subagent 生成 HTML；
 *    否则建壳即停（文稿可见可改，等用户过目后 generate_deck 再生成）
 *
 * 「做完」的口径与其余装卸类一致，不是特例：本函数返回时它断言的事实（壳已建好、autoGenerate
 * 时 subagent 已派出）都已成立——「一件事已经开始」本身就是个当场成立的真结果。
 *
 * 出错回滚：步骤 2-4 任一抛错时，已建目录 + 已注册 deck 都要清理，避免孤儿。
 */
import { promises as fs } from 'node:fs';
import type { DeckCreateProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';
import { getProject } from '../projects/store';
import { safeWriteAsync } from '../fs/safeWrite';
import { createDeck, setActiveDeckId, listDecks, unregisterDeck, getActiveDeckId } from '../deck/store';
import { initManifest } from '../deck/history';
import { deckNarrativePath } from '../deck/pathResolver';
import { dispatchDeckSubagent, buildSubagentRawPlan } from '../deck/dispatchSubagent';

type Broadcast = (ev: ServerEvent) => void;

const NARRATIVE_STUB = '# 叙事文稿\n\n';

const INITIAL_STUB_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="oru-deck-size" content="1920x1080">
  <title>生成中...</title>
</head>
<body style="font-family: system-ui; padding: 4rem; color: #6b6b70; text-align: center;">
  <p>Deck 生成中…</p>
  <p style="font-size: 12px; opacity: 0.6;">Subagent 已派出，生成完成后会自动刷新预览。</p>
</body>
</html>
`;

export async function performDeckCreate(
  proposal: DeckCreateProposal,
  broadcast: Broadcast,
): Promise<{ deckId: string; deckPath: string; dispatched: boolean }> {
  if (proposal.targetProjectId === null) {
    throw new Error('deck.create proposal 缺 targetProjectId（active 项目应在 propose 阶段填好）');
  }
  const project = await getProject(proposal.targetProjectId);

  // 1. 建 deck 目录 + 注册表
  const deck = await createDeck({
    projectId: proposal.targetProjectId,
    projectPath: project.path,
    name: proposal.deckName,
    deckSkillId: proposal.deckSkillId,
  });

  try {
    // 2. 写 stub + 初始化 manifest + 叙事文稿（模型起草的全文，空串才回退占位）
    await initManifest(deck.id, INITIAL_STUB_HTML);
    await safeWriteAsync(deckNarrativePath(deck.path), proposal.narrative || NARRATIVE_STUB);

    // 3. 切 active deck + 广播（无论是否立即生成都做——文稿已可见可改）
    setActiveDeckId(deck.id);
    const decks = await listDecks(proposal.targetProjectId);
    broadcast({
      type: 'artifact.state',
      projectId: proposal.targetProjectId,
      decks,
      activeArtifactId: deck.id,
    });

    // 4. 仅 autoGenerate 时立即派 subagent 生成；否则建壳即停，等用户过目后 generate_deck
    if (proposal.autoGenerate) {
      const dispatch = await dispatchDeckSubagent({
        artifactId: deck.id,
        deckPath: deck.path,
        deckSkillId: proposal.deckSkillId,
        conversationId: proposal.conversationId,
        title: `生成 deck ${proposal.deckName}`,
        description: proposal.brief,
        targetProjectId: proposal.targetProjectId,
        rawPlan: buildSubagentRawPlan({
          brief: proposal.brief,
          deckSkillId: proposal.deckSkillId,
          deckPath: deck.path,
          sizeHint: proposal.sizeHint,
        }),
        broadcast,
      });
      if (!dispatch.ok) {
        throw new Error(dispatch.message);
      }
    }

    return { deckId: deck.id, deckPath: deck.path, dispatched: proposal.autoGenerate === true };
  } catch (e) {
    // 步骤 2-4 任一抛错时回滚：清磁盘目录 + 撤注册表 + 复位 active deck
    await unregisterDeck(deck.id).catch(() => undefined);
    await fs.rm(deck.path, { recursive: true, force: true }).catch(() => undefined);
    if (getActiveDeckId() === deck.id) setActiveDeckId(null);
    throw e;
  }
}
