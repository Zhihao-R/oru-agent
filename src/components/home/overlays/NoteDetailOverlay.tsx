/**
 * 笔记详情浮层（A5）——着色 mono 类型 + 日期 + dream 眉标；衬线标题；正文只读（小知执笔）；
 * # 标签（宿主给了 onPickTag 才可点=按标签筛选，否则静态）；来源行 +「查看原文 ›」（一期跳来源对话，E4）；
 * 演化行可点开，展出校对依据与前一版全文（E2）；右上垃圾桶删除（走系统回收站）。
 * 用户备忘徽（source=user-direct）按 D3 补进眉标。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { EpisodeType } from '@shared/types';
import { useMemoryStore } from '@/stores/memoryStore';
import { useConversationStore } from '@/stores/conversationStore';
import { ALL_TYPES, TYPE_CHIP_STYLE, typeLabel } from '@/components/memory/shared/typeLabels';
import { Overlay } from './Overlay';

type EpisodeEntry = ReturnType<typeof useMemoryStore.getState>['episodes'][number];

const TAG_CLASS = 'text-[12px] text-text-quaternary';

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

export type NoteDetailOverlayProps = {
  relPath: string;
  onClose: () => void;
  /** 按标签筛选。省略＝宿主没有笔记墙可筛（如对话流），标签退化成静态文字。 */
  onPickTag?: (tag: string) => void;
  onViewSource: (convId: string) => void;
};

export function NoteDetailOverlay({ relPath, onClose, onPickTag, onViewSource }: NoteDetailOverlayProps) {
  const { t } = useTranslation('home');
  const { t: tm } = useTranslation('memory');
  const ep = useMemoryStore(
    (s) => s.episodes.find((e) => e.relPath === relPath) ?? s.retiredEpisodes?.find((e) => e.relPath === relPath) ?? null,
  );
  const content = useMemoryStore((s) => s.episodeContent[relPath]);
  const fetchEpisodeContent = useMemoryStore((s) => s.fetchEpisodeContent);
  const deleteEpisode = useMemoryStore((s) => s.deleteEpisode);

  useEffect(() => {
    if (!content) void fetchEpisodeContent(relPath);
  }, [content, fetchEpisodeContent, relPath]);

  if (!ep) return null;
  const typeKey: EpisodeType = ALL_TYPES.includes(ep.type as EpisodeType) ? (ep.type as EpisodeType) : 'agent';
  const chip = TYPE_CHIP_STYLE[typeKey];
  const sourceConvId = ep.sources?.[0] ?? null;

  const del = () => {
    void deleteEpisode(relPath);
    onClose();
  };

  return (
    <Overlay
      width={500}
      onClose={onClose}
      topRight={
        <button
          type="button"
          onClick={del}
          title={t('noteDetail.deleteTitle')}
          className="text-text-quaternary transition-colors hover:text-danger"
        >
          <Trash2 size={13} strokeWidth={1.3} />
        </button>
      }
    >
      <div className="px-[38px] pb-[26px] pt-[34px]">
        <div className="flex items-baseline gap-3 font-mono text-[10.5px] tracking-[0.12em]">
          <span style={{ color: chip.color }}>{typeLabel(typeKey, tm)}</span>
          <span className="text-text-quaternary">{ep.date}</span>
          {ep.correctedAt && <span className="text-text-quaternary">dream</span>}
          {ep.source === 'user-direct' && <span className="text-text-quaternary">{tm('events.userMemo')}</span>}
        </div>
        <div className="mt-3.5 font-serif text-[19px] font-semibold leading-[1.55] tracking-[-0.005em] text-text-primary">
          {ep.title || ep.description || tm('events.noTitle')}
        </div>
        <p className="mt-3 whitespace-pre-wrap text-[14.5px] leading-[1.9] text-text-primary">
          {content ? stripFrontmatter(content) : tm('common:loading')}
        </p>
        {ep.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-4">
            {ep.tags.map((tag) =>
              onPickTag ? (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onPickTag(tag)}
                  className={`${TAG_CLASS} hover:text-accent-deep`}
                >
                  # {tag}
                </button>
              ) : (
                <span key={tag} className={TAG_CLASS}>
                  # {tag}
                </span>
              ),
            )}
          </div>
        )}

        <hr className="mt-[22px] h-px border-0 bg-border" />
        <div className="mt-4 flex flex-col gap-2.5">
          <div className="flex items-baseline gap-3.5">
            <span className="w-[30px] shrink-0 font-mono text-[10px] tracking-[0.14em] text-text-quaternary">
              {t('noteDetail.source')}
            </span>
            <SourceText convId={sourceConvId} epSource={ep.source} />
            {sourceConvId && (
              <button
                type="button"
                onClick={() => onViewSource(sourceConvId)}
                className="shrink-0 text-[12px] text-accent-deep"
              >
                {t('noteDetail.viewOriginal')}
              </button>
            )}
          </div>
          <EvolutionRow episode={ep} />
        </div>
      </div>
    </Overlay>
  );
}

function SourceText({ convId, epSource }: { convId: string | null; epSource?: string }) {
  const { t: tm } = useTranslation('memory');
  const title = useConversationStore((s) => (convId ? s.byId[convId]?.title : undefined));
  const text = title ?? (epSource === 'user-direct' ? tm('events.userMemo') : convId ?? '—');
  return <span className="min-w-0 flex-1 text-[12.5px] text-text-secondary">{text}</span>;
}

/** 演化行——可点开，展出校对依据（从 changelog 当夜明细捞）与前一版全文（predecessor）。 */
function EvolutionRow({ episode }: { episode: EpisodeEntry }) {
  const { t } = useTranslation('home');
  const [open, setOpen] = useState(false);
  const predecessor = useMemoryStore((s) => s.predecessorByPath[episode.relPath]);
  const fetchPredecessor = useMemoryStore((s) => s.fetchPredecessor);
  const changelog = useMemoryStore((s) => s.changelog);
  const fetchChangelog = useMemoryStore((s) => s.fetchChangelog);

  // 挂载即拉前一版，据此判断是否有演化可展（correctedAt 也算演化信号）
  useEffect(() => {
    if (predecessor === undefined) void fetchPredecessor(episode.relPath);
  }, [predecessor, fetchPredecessor, episode.relPath]);
  useEffect(() => {
    if (open && episode.correctedAt && changelog === null) void fetchChangelog();
  }, [open, episode.correctedAt, changelog, fetchChangelog]);

  // 既非纠错、也无前一版 → 无演化，不渲染
  if (!episode.correctedAt && predecessor == null) return null;

  const stem = (episode.relPath.split('/').pop() ?? '').replace(/\.md$/, '');
  const evidenceLines = (changelog ?? '')
    .split('\n')
    // i18n-exempt：匹配 changelog「- 校对…」明细行的数据格式（与 EventsSection 同一约定），非 UI 文案
    .filter((l) => l.startsWith('- 校对') && (l.includes(`${stem}：`) || l.includes(`${stem}（`)))
    .map((l) => l.slice(2));

  return (
    <div className="flex items-baseline gap-3.5">
      <span className="w-[30px] shrink-0 font-mono text-[10px] tracking-[0.14em] text-text-quaternary">
        {t('noteDetail.evolution')}
      </span>
      <div className="min-w-0 flex-1">
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-[12.5px] text-accent-deep">
          {open ? '▾' : '▸'} {t('noteDetail.evidenceLabel')}
        </button>
        {open && (
          <div className="mt-2 flex flex-col gap-2.5">
            {episode.correctedAt && (
              <div className="border-l-2 border-accent-line bg-sunken-2 px-3 py-2.5 text-[12px] leading-relaxed text-text-secondary">
                {evidenceLines.length > 0 ? (
                  evidenceLines.map((l) => (
                    <div key={l} className="whitespace-pre-wrap">
                      {l}
                    </div>
                  ))
                ) : (
                  <div className="text-text-tertiary">
                    {t('night.evidence')} · {episode.correctedAt}
                  </div>
                )}
              </div>
            )}
            {predecessor && (
              <div className="border-l-2 border-border bg-sunken-2 px-3 py-2.5 text-[12px] leading-relaxed text-text-secondary">
                <div className="mb-1 text-text-tertiary">
                  {t('noteDetail.predecessorLabel')} · {predecessor.date} · {predecessor.title}
                </div>
                <div className="whitespace-pre-wrap">{predecessor.body}</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
