/**
 * 装卸类提案执行完成后的对话流痕迹——成败各一条 chip + 相应全量状态广播。
 *
 * **唯一落点**：同步路径（工具在原轮等结果，经 `onProposalOutcome` 把 broadcast 递进来）与
 * 独立执行器（无工具在等时的路径）共用本函数。两条路径各写一份必然漂移——失败 chip 尤其容易漏。
 *
 * mcp.* / deck.create 不产 chip（前者的痕迹在提案卡上，后者在四列布局里），本函数对它们 no-op。
 *
 * 文案按 owner 语言取词：chip 是上屏内容，与 `perform*` 抛出的技术原文（进 tool_result 喂 AI）
 * 分属 i18n 四类边界的两侧。
 */
import type { ActionProposal, SkillModuleActionPayload } from '@shared/types';
import type { ProposalOutcome, ProposalWarning } from '@shared/proposals/outcome';
import type { ServerEvent } from '@shared/protocol';
import { writeSkillModuleChip, broadcastSkillsState, broadcastPluginsState } from '../skills/chipWriter';
import { getSettings } from '../projects/store';
import { resolveEffectiveLang } from '../i18n/effectiveLang';
import { t } from '../i18n/t';

type Broadcast = (ev: ServerEvent) => void;
type SkillModuleChipKind = Parameters<typeof writeSkillModuleChip>[0]['kind'];
type Lang = Parameters<typeof t>[1];

/**
 * 每个 kind 的 chip 形态：chip 种类 + 成败两条文案键。
 * 键写字面量而非按词根拼——拼出来的键 grep 不到，而这个仓库的 i18n 核对全靠 grep
 * （key-alignment 门槛只管 en↔zh 对称，不管「代码里用的键存不存在」）。
 */
const CHIP_OF: Partial<
  Record<ActionProposal['kind'], { chipKind: SkillModuleChipKind; okKey: string; failedKey: string }>
> = {
  'skill.install': { chipKind: 'skill-install', okKey: 'main:proposalChip.skillInstallOk', failedKey: 'main:proposalChip.skillInstallFailed' },
  'skill.create': { chipKind: 'skill-create', okKey: 'main:proposalChip.skillCreateOk', failedKey: 'main:proposalChip.skillCreateFailed' },
  'skill.patch': { chipKind: 'skill-patch', okKey: 'main:proposalChip.skillPatchOk', failedKey: 'main:proposalChip.skillPatchFailed' },
  'plugin.install': { chipKind: 'plugin-install', okKey: 'main:proposalChip.pluginInstallOk', failedKey: 'main:proposalChip.pluginInstallFailed' },
  'plugin.uninstall': { chipKind: 'plugin-uninstall', okKey: 'main:proposalChip.pluginUninstallOk', failedKey: 'main:proposalChip.pluginUninstallFailed' },
  'plugin.update': { chipKind: 'plugin-update', okKey: 'main:proposalChip.pluginUpdateOk', failedKey: 'main:proposalChip.pluginUpdateFailed' },
};

/** chip 的 id / 兜底显示名——全部从提案自身派生，失败路径（没有 perform 结果）同样有名字可用。 */
function chipIdentity(proposal: ActionProposal): { id: string; name: string } {
  switch (proposal.kind) {
    case 'skill.install':
      return { id: proposal.skillId, name: proposal.skillManifest.name };
    case 'skill.create':
      return { id: proposal.skillName, name: proposal.skillName };
    case 'skill.patch':
      return { id: proposal.name, name: proposal.name };
    case 'plugin.install':
      return { id: proposal.pluginManifest.name, name: proposal.pluginManifest.name };
    case 'plugin.uninstall':
    case 'plugin.update':
      return { id: proposal.pluginId, name: proposal.pluginId };
    default:
      // 不可达：调用方已按 CHIP_OF 早退。硬失败而非编个兜底名——将来漏登记 kind 时要能看见。
      throw new Error(`chipIdentity: 未登记的 kind ${(proposal as { kind: string }).kind}`);
  }
}

export async function writeProposalOutcomeChip(
  proposal: ActionProposal,
  outcome: ProposalOutcome,
  broadcast: Broadcast,
): Promise<void> {
  const spec = CHIP_OF[proposal.kind];
  if (!spec) return; // mcp.* / deck.create / bash / … 无 chip

  // chip 与状态广播都是 best-effort：写失败只记日志，绝不冒泡去翻转已定的执行结果
  // （否则一次成功的安装会被外层 catch 改判 failed，而 skill 其实已落盘注册）。
  try {
    const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
    const identity = chipIdentity(proposal);
    const name = (outcome.ok && outcome.name) || identity.name;
    const errorMessage = outcome.ok ? undefined : outcome.error;
    const text = outcome.ok
      ? t(spec.okKey, lang, { name }) + warningSuffix(outcome.warnings, lang)
      : t(spec.failedKey, lang, { error: outcome.error });

    const payload: SkillModuleActionPayload = { id: identity.id, name, errorMessage };
    await writeSkillModuleChip({
      conversationId: proposal.conversationId,
      kind: spec.chipKind,
      text,
      payload,
      broadcast,
    });
    // 该刷哪张全量列表：plugin 三件套刷拓展页；skill 族刷技能页，但 skill.patch 改的可能是
    // plugin manifest，那时同样刷拓展页。
    const hitsPlugins =
      proposal.kind.startsWith('plugin.') ||
      (proposal.kind === 'skill.patch' && proposal.target === 'plugin-manifest');
    if (hitsPlugins) await broadcastPluginsState(broadcast);
    else await broadcastSkillsState(broadcast);
  } catch (e) {
    console.warn(`[oru.proposals] ${proposal.kind} chip / 广播失败（忽略，不影响执行结果）:`, e);
  }
}

function warningSuffix(warnings: ProposalWarning[] | undefined, lang: Lang): string {
  if (!warnings?.length) return '';
  const parts = warnings.map((w) =>
    w.code === 'mcp-conflict-skipped'
      ? t('main:proposalChip.mcpConflictSkipped', lang, { count: w.names.length, names: w.names.join(', ') })
      : t('main:proposalChip.mcpStartFailed', lang, { count: w.names.length }),
  );
  return t('main:proposalChip.warningSuffix', lang, { warnings: parts.join('；') });
}
