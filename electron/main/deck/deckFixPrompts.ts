/**
 * Deck 收尾回路的回喊 / 标注文案（纯函数，单测覆盖）。
 *
 * runner 收尾循环跑客观体检后，把发现**建议式**回喂给子 agent（不是续接旧会话，而是发一条新消息）。
 * 因为新一轮是全新会话、模型看不到上轮对话，所以消息里既给客观项清单、也带上 rawPlan（原始生成
 * 指令）——纯结构硬伤（溢出/裂图）靠重读 index.html 能修，但空白页要知道"这页本该放什么"才补得对，
 * 那信息只在 rawPlan 里。
 *
 * 建议式语义（PRD 决策一）：回喂是硬保证（模型绕不过看见），但修不修、收不收工由模型判断；模型
 * 停手后仍残留的客观项，用 residualNote 中性如实标注交回用户，不臆断是"有意保留"还是"未及修复"。
 */
import type { DeckValidationError } from './validateDeck';

const KIND_LABEL: Record<DeckValidationError['kind'], string> = {
  structure: '结构契约',
  'broken-image': '失效图',
  overflow: '内容溢出',
  blank: '空白页',
  unrecognized: '未识别内容',
};

/** 渲染单条定位前缀：null 页号 = deck 整体（结构级问题），否则"第 N 页"。 */
function locationLabel(page: number | null): string {
  return page == null ? 'deck 整体' : `第 ${page} 页`;
}

/** 把 DeckValidationError[] 排成可读清单（deck 整体的 null 页排在最前，其余按页号升序）。 */
export function formatErrorList(errors: DeckValidationError[]): string {
  return [...errors]
    .sort((a, b) => (a.page ?? -1) - (b.page ?? -1))
    .map((e) => `  - ${locationLabel(e.page)}【${KIND_LABEL[e.kind]}】${e.message}`)
    .join('\n');
}

/** 建议式回喊一轮的消息：客观项清单 + 原任务意图 + "建议修/可保留+说明" + "只处理列出的页"。 */
export function buildAdvisePrompt(errors: DeckValidationError[], rawPlan: string): string {
  return [
    `收尾客观体检发现以下 ${errors.length} 项：`,
    '',
    formatErrorList(errors),
    '',
    '这些通常是该修的低级硬伤，**建议修掉**。如果你判断某项该保留——比如用户要求无视、或它是有意设计——**不用改它**，但请在收尾说明里点明保留了什么、为什么。',
    '只处理上面列出的页、别重做整个 deck，也别改没列出的页。空白页要补内容时，参考下面的原始生成意图。',
    '',
    '── 原始任务意图 ──',
    rawPlan,
  ].join('\n');
}

/**
 * 标注修改收尾工具（任务 9）的回喂文本：客观项清单 + "修掉再调 / 带 acknowledge_residual 保留"处置。
 * 与生成路 buildAdvisePrompt 不同——修改路 AI 在当前会话看得到原标注，无需重灌 rawPlan（决策 2）。
 * 复用 formatErrorList：page===null 的结构项归"deck 整体"、不丢（决策 6 注）。
 */
export function buildRefeedText(errors: DeckValidationError[]): string {
  return [
    `收尾客观体检发现以下 ${errors.length} 项仍在：`,
    '',
    formatErrorList(errors),
    '',
    '这些通常是该修的低级硬伤——**修掉后再次调用本工具收尾**即可。',
    '若你判断某项该保留（用户要求无视 / 有意设计）：不用改它，但带上 `acknowledge_residual: true` 再次调用本工具即可定版，并在给用户的回复里说明保留了哪几页、为什么。',
  ].join('\n');
}

/** runner 每轮回喂发给用户的进度文字（决策 7：过程只展示文本）。 */
export function fixProgressText(round: number, errors: DeckValidationError[]): string {
  return `收尾体检第 ${round} 轮：发现 ${errors.length} 处客观项，已回喂模型…`;
}

/**
 * 残留客观项的中性标注（PRD 决策五）：模型停手后仍存在的项，回报卡追加这一条。
 * **不臆断**是"有意保留"还是"未及修复"——从外部分不清，把判断权和知情权都留给用户。
 */
export function residualNote(errors: DeckValidationError[]): string {
  return [
    'ℹ️ 下列客观体检项在收尾后仍存在（模型已被告知；可能为有意保留，也可能未及修复）。如需处理可要求其再改：',
    formatErrorList(errors),
  ].join('\n');
}
