/**
 * `perform*` 的**已知失败**——同一次失败要说给两个读者听，口径相反：
 *
 * - **回执**（tool_result，喂 AI）要技术原文。按 i18n 四类边界，含协议 / jargon 的诊断错误不翻，
 *   模型也不该因为界面语言变了就看到不同的错误。
 * - **上屏**（提案卡 failureMessage、对话流 chip）要 owner 语言——那是给人看的。
 *
 * 所以已知失败带一个 code：抛的时候给技术原文，上屏时按 code 取词。未知失败（普通 Error）
 * 两侧都原样透传 message——编不出译文时如实给原文，好过猜一个。
 *
 * 技术原文与译文在这里成对定义，避免两处各写一遍而漂移。
 */
import { t } from '../i18n/t';

type Lang = Parameters<typeof t>[1];

/** 已知失败的技术原文模板（回执侧用）。key 同时是 `main:proposalFailure.*` 的译文键。 */
const TECHNICAL: Record<string, (p: Record<string, string>) => string> = {
  // ── skill.install ──
  'skillInstallInFlight': (p) => `skill ${p.id} 正在安装中，请勿重复触发`,
  'skillAlreadyInstalled': (p) => `skill ${p.id} 已安装`,
  'skillDestExists': (p) => `目标目录已存在：~/.oru/skills/${p.id}`,
  'skillStatFailed': (p) => `检查目标目录失败：${p.error}`,
  'skillCloneFailed': (p) => `git clone 失败：${p.error}`,
  'skillMdNotFound': () => '仓库里找不到 SKILL.md（根或 skills/<x>/ 下都没有）',
  'skillSourceGone': (p) => `源目录不存在或缺 SKILL.md：${p.path}`,
  'skillCopyFailed': (p) => `复制 skill 到 ~/.oru/skills/ 失败：${p.error}`,
  'skillRegisterFailed': (p) => `注册失败：${p.error}`,
  // ── skill.create / patch ──
  'skillNameTaken': (p) => `skill ${p.name} 已存在`,
  'skillWriteFailed': (p) => `写盘失败: ${p.error}`,
  'skillNotFound': (p) => `skill 不存在: ${p.name}`,
  'skillInPluginNotPatchable': () => 'plugin 内 skill 不可 patch——请改用 plugin-manifest 修激活描述',
  'patchTargetReadFailed': (p) => `读取目标文件失败: ${p.error}`,
  'patchOldStringMissing': () => 'oldString 在目标文件中未找到（可能已被其他 patch 改过）',
  'patchOldStringAmbiguous': (p) => `oldString 在目标文件中出现 ${p.count} 次，不唯一`,
  // ── plugin ──
  'pluginAlreadyInstalled': (p) => `plugin ${p.id} 已装在 ~/.oru/plugins/`,
  'pluginStatFailed': (p) => `检查目标目录失败: ${p.error}`,
  'pluginCloneFailed': (p) => `git clone 失败: ${p.error}`,
  'pluginManifestWriteFailed': (p) => `写 .oru-plugin.json 失败: ${p.error}`,
  'pluginRegisterFailed': (p) => `注册失败: ${p.error}`,
  'pluginNotFound': (p) => `plugin 不存在: ${p.id}`,
  'pluginHasDependents': (p) => `存在依赖方，请先卸载: ${p.dependents}`,
  'pluginRemoveDirFailed': (p) => `删目录失败: ${p.error}`,
  'pluginGitFailed': (p) => `git fetch/checkout 失败: ${p.error}`,
  'pluginReloadFailed': (p) => `升级后重载失败: ${p.error}`,
  // ── mcp ──
  'mcpServerNotFound': (p) => `server not found: ${p.serverId}`,
  'mcpStartFailed': (p) => `server failed to start: ${p.error}`,
  // 回执只给诊断事实；「去 Settings 调整」那句指引是给人的，只在上屏文案里出现。
  'mcpUpdateStartFailed': (p) => `server failed to start after update (config already written): ${p.error}`,
};

export class ProposalFailure extends Error {
  constructor(
    readonly code: keyof typeof TECHNICAL,
    readonly params: Record<string, string>,
  ) {
    super(TECHNICAL[code]!(params));
    this.name = 'ProposalFailure';
  }
}

/** 抛一个已知失败：message 是技术原文（进回执），code + params 供上屏侧取词。 */
export function failure(code: keyof typeof TECHNICAL, params: Record<string, string> = {}): ProposalFailure {
  return new ProposalFailure(code, params);
}

/**
 * 上屏文案（提案卡 failureMessage / chip）：已知失败按 owner 语言取词，未知失败原样透传。
 * 内嵌的诊断原因（`{{error}}`）本身仍是上游原文——那部分属「含 jargon 的诊断错误」，不翻。
 */
export function surfaceFailureText(e: unknown, lang: Lang): string {
  if (e instanceof ProposalFailure) return t(`main:proposalFailure.${e.code}`, lang, e.params);
  return e instanceof Error ? e.message : String(e);
}
