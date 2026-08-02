/**
 * 记忆卡「查看」的落点——就地覆盖消息区，不再把用户弹去手账页。
 *
 * 分类只看卡片 payload 的 scope：主进程产卡时（memory/tools.ts 的 cardMetaForDoc）已按路径
 * 分过一次，渲染端再解析一遍路径就成了两份会各自漂移的规则。不用 type 判，是因为它有历史值
 * （persona / fact / preference）要兜，scope 三值没有这层包袱。唯一的例外是项目名——payload
 * 没带 projectId，只能从 relPath 取。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemoryRecordPayload } from '@shared/types';
import { ProfileDocView } from '@/components/memory/ProfileDocView';
import { NoteDetailOverlay } from '@/components/home/overlays/NoteDetailOverlay';
import { Overlay } from '@/components/home/overlays/Overlay';
import { useEditorStore, refKey } from '@/stores/editorStore';
import { useMemoryStore } from '@/stores/memoryStore';
import { useProjectStore } from '@/stores/projectStore';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useOruName } from '@/lib/oruName';
import { memoryDocTitle, projectIdOf } from './memoryDocTitle';

type Props = {
  record: MemoryRecordPayload;
  onClose: () => void;
};

export function MemoryRecordOverlay({ record, onClose }: Props) {
  return record.type === 'episode' ? (
    <EpisodeOverlay relPath={record.relPath} onClose={onClose} />
  ) : (
    <DocOverlay record={record} onClose={onClose} />
  );
}

/**
 * 事件记忆 → 笔记详情。两处兜底都为了「点了必须有反应」：
 * episodes 列表只有手账页会拉，对话页得自己拉一次；拉完仍不在列表的（被 dream 取代、被整理掉、
 * 被删——这些都会挪进 archived/，relPath 对不上），明说它没了，而不是让 NoteDetailOverlay
 * 悄悄 return null 什么都不显示。
 */
function EpisodeOverlay({ relPath, onClose }: { relPath: string; onClose: () => void }) {
  const { t } = useTranslation('chat');
  const known = useMemoryStore((s) => s.episodes.some((e) => e.relPath === relPath));
  const fetchEpisodes = useMemoryStore((s) => s.fetchEpisodes);
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const setActive = useConversationStore((s) => s.setActive);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (known) return;
    let alive = true;
    void fetchEpisodes().finally(() => {
      if (alive) setSettled(true);
    });
    return () => {
      alive = false;
    };
  }, [known, fetchEpisodes]);

  if (!known) {
    return (
      <Overlay width={500} onClose={onClose}>
        <div className="px-[38px] py-[34px] text-[13px] text-text-tertiary">
          {settled ? t('memoryCard.gone') : t('common:loading')}
        </div>
      </Overlay>
    );
  }

  // 标签筛选的宿主（手账页笔记墙）不在对话流里，故不传 onPickTag——标签渲染成静态文字。
  return (
    <NoteDetailOverlay
      relPath={relPath}
      onClose={onClose}
      onViewSource={(convId) => {
        if (activeAgentId) setActive(activeAgentId, convId);
        onClose();
      }}
    />
  );
}

/** 档案类记忆（用户 / Oru 自我 / 项目）→ 档案视图。 */
function DocOverlay({ record, onClose }: { record: MemoryRecordPayload; onClose: () => void }) {
  const { t } = useTranslation('home');
  const oruName = useOruName();
  const isProject = record.scope === 'project';
  const projectId = isProject ? projectIdOf(record.relPath) : '';
  const projectName = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.name ?? projectId,
  );
  const key = refKey({ kind: 'memory', relPath: record.relPath });

  useEffect(() => {
    // 同一份档案第二次打开时，ProfileDocView 的 openRef 对已加载的桶直接早返回、不重读
    // （editorStore.ts:611）——而记忆卡的场景恰恰是「刚写完就来看」，不补这一次读盘，
    // 用户会看到上次打开时的旧全文，本回合刚记下的那句反而不在里面。
    const f = useEditorStore.getState().files[key];
    if (f && !f.loading) void useEditorStore.getState().syncFromDisk(key);
  }, [key]);

  const title = memoryDocTitle(record, { oruName, projectName, t });

  return (
    <ProfileDocView
      relPath={record.relPath}
      title={title}
      eyebrow={t(isProject ? 'projectDetail.eyebrow' : 'aboutFull.eyebrow')}
      eyebrowEditing={t(isProject ? 'projectDetail.eyebrowEditing' : 'aboutFull.eyebrowEditing')}
      onClose={onClose}
    />
  );
}
