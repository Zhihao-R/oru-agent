/**
 * Episode type 的展示映射。
 * 后端字段保持英文（frontmatter `type: user` 不变）；展示 label 经 i18n（memory ns）。
 */
import type { TFunction } from 'i18next';
import type { EpisodeType } from '@shared/types';

export const ALL_TYPES: EpisodeType[] = ['user', 'feedback', 'project', 'reference', 'agent'];

/** EpisodeType → 中文展示 label，t 由调用方按 memory ns 绑定传入。 */
export function typeLabel(type: EpisodeType, t: TFunction): string {
  return t(`episodeType.${type}`);
}

/**
 * 五类各一种 chip 配色——type → 数据色 token 的映射。
 * 色值（含深色变体）作为词汇表无位的 sanctioned 例外，集中声明在 src/index.css 的
 * `--note-*` token 里；此处只做「哪类用哪个 token」的映射，dark 经 .dark 级联自动跟随。
 */
export const TYPE_CHIP_STYLE: Record<EpisodeType, { color: string; background: string }> = {
  user: { color: 'var(--note-user)', background: 'var(--note-user-bg)' },
  feedback: { color: 'var(--note-feedback)', background: 'var(--note-feedback-bg)' },
  project: { color: 'var(--note-project)', background: 'var(--note-project-bg)' },
  reference: { color: 'var(--note-reference)', background: 'var(--note-reference-bg)' },
  agent: { color: 'var(--note-agent)', background: 'var(--note-agent-bg)' },
};
