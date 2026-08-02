/**
 * 左栏对话栏 —— 时间日志（对话栏整理 2026-06-19）。
 *
 * 主对话已取消，列表是一份按时间堆叠的日志：
 * - 顶部固定：「+ 新对话」（克制，靠位置当首要入口，不做填充色大按钮）+ 搜索图标（点开才出搜索栏）。
 * - 时间分段：今天摊开、本周可收起（默认收起，按 updatedAt 倒序）；更早自动折进底部「更早」收纳区。
 * - 「更早」收纳区同处两类：更早的普通对话 + 随手评点（aside）——不并排两个抽屉。
 * - 搜索：标题 + 消息正文一起搜，命中按对话聚合、长消息只截关键词上下文、点命中跳到那条消息并点亮。
 *
 * 红线：自动整理只「折叠」，绝不销毁。手动 X 是归档（收进「已归档」、可恢复）；彻底删除
 * （不可逆）只在「已归档」区里、走强确认。两套机制别混：归档=设 archivedAt，删除=移出索引 + 历史落 .bak。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Archive, ChevronRight, MessageSquare, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { Conversation } from '@shared/types';
import type { ConvSearchHit, ConvSearchResultEvent } from '@shared/protocol';
import { cn } from '@/lib/cn';
import { ConversationIcon } from '@/components/ConversationIcon';
import { Dialog } from '@/components/ui/Dialog';
import { DeleteConfirm } from '@/components/ui/DeleteConfirm';
import { Button } from '@/components/ui/Button';
import { wsClient } from '@/lib/ws';
import { bucketLabel } from '@/lib/conversationBuckets';
import { groupConversations } from '@/lib/conversationGrouping';
import { snippet, splitHighlight } from '@/lib/searchHighlight';
import { useAgentStore } from '@/stores/agentStore';
import { useOruName } from '@/lib/oruName';
import { useConversationStore } from '@/stores/conversationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useLayoutStore } from '@/stores/layoutStore';
import { useConvBadges } from '@/lib/useNotifications';
import type { ConvBadge } from '@/lib/conversationStatus';

// 稳定空数组：避免 zustand selector 每次返回新 [] 触发无限重渲染
const EMPTY_CONVS: Conversation[] = [];

/** 一行对话所需的状态 + 回调——TimeLog / EarlierDrawer / ConvRow 三处共用，整组透传不逐个手写 */
type RowControls = {
  activeId: string | null;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  badgeByConv: Record<string, ConvBadge>;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  /** 活跃行动作：归档（收进「已归档」，可恢复） */
  onArchive: (c: Conversation) => void;
  /** 已归档行动作：彻底删除（从索引移除、历史落 .bak，应用内不可恢复） */
  onDelete: (c: Conversation) => void;
};

export function ConversationList() {
  const { t } = useTranslation('conversation');
  const oruName = useOruName();
  const agentId = useAgentStore((s) => s.activeAgentId);
  const list = useConversationStore((s) =>
    agentId ? s.byAgent[agentId] ?? EMPTY_CONVS : EMPTY_CONVS,
  );
  const activeId = useConversationStore((s) =>
    agentId ? s.activeByAgent[agentId] ?? null : null,
  );
  const setActive = useConversationStore((s) => s.setActive);
  const openConversationAt = useConversationStore((s) => s.openConversationAt);
  const archive = useConversationStore((s) => s.archive);
  const remove = useConversationStore((s) => s.remove);
  const rename = useConversationStore((s) => s.rename);
  // 归档前是否确认（全局偏好，缺省=确认）。「不再提醒」会把它置 false。
  const confirmBeforeArchive = useSettingsStore((s) => s.settings.confirmBeforeArchive);
  const updateSettings = useSettingsStore((s) => s.update);

  // 四态标记（待办 / 进行中 / 未读 / 无）——与通知中心、oru 角标同一处判定（conversationStatus）。
  // 旧逻辑只数 triggeredBySubagent 的 pending、且漏主 agent，故整体换成 deriveConvBadge。
  const badgeByConv = useConvBadges(agentId);

  // 当前正在重命名的对话 id；null 表示无重命名进行中
  const [editingId, setEditingId] = useState<string | null>(null);
  // 待确认归档 / 待确认彻底删除的对话（null = 无）。两者互斥，分开存便于各自文案。
  const [pendingArchive, setPendingArchive] = useState<Conversation | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  // 搜索栏是否展开（低频动作，平时只是个图标）。态在 layoutStore：切出对话视图时统一收起（见 setSidebarView）
  const searchOpen = useLayoutStore((s) => s.convSearchOpen);
  const setSearchOpen = useLayoutStore((s) => s.setConvSearchOpen);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ConvSearchHit[] | null>(null);
  // 搜索展开时聚焦输入框（输入框常驻 DOM 以便做展开动画，不能靠 autoFocus）
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // E 键：当前 active 行进重命名态。避开 input / textarea / contentEditable 内打字
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'e' && e.key !== 'E') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae) {
        const t = ae.tagName;
        if (t === 'INPUT' || t === 'TEXTAREA' || ae.isContentEditable) return;
      }
      if (!agentId || !activeId || editingId) return;
      e.preventDefault();
      setEditingId(activeId);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [agentId, activeId, editingId]);

  // 搜索：标题 + 消息正文全局搜，防抖 200ms。query 回带对齐，丢弃晚到的旧结果。
  const trimmedQuery = query.trim();
  useEffect(() => {
    if (!searchOpen || !agentId || !trimmedQuery) {
      setResults(null);
      return;
    }
    const handle = setTimeout(() => {
      void wsClient
        .request<ConvSearchResultEvent>({ type: 'conv.search', agentId, query: trimmedQuery })
        .then((res) => {
          if (res.type === 'conv.search.result' && res.query === trimmedQuery) {
            setResults(res.groups);
          }
        })
        .catch(() => {
          // 静默：搜索失败保持现状
        });
    }, 200);
    return () => clearTimeout(handle);
  }, [trimmedQuery, searchOpen, agentId]);

  if (!agentId) {
    return <div className="px-3 py-3 text-xs text-text-tertiary">{t('loading', { name: oruName })}</div>;
  }

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery('');
    setResults(null);
  };

  const inSearch = searchOpen && trimmedQuery.length > 0;

  const controls: RowControls = {
    activeId,
    editingId,
    setEditingId,
    badgeByConv,
    onOpen: (id) => setActive(agentId, id),
    onRename: (id, title) => void rename(agentId, id, title),
    // 归档：勾过「不再提醒」(confirmBeforeArchive===false) 直接归档，否则弹确认
    onArchive: (c) => {
      if (confirmBeforeArchive === false) void archive(agentId, c.id);
      else setPendingArchive(c);
    },
    // 彻底删除：不可逆，永远走强确认
    onDelete: (c) => setPendingDelete(c),
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶行：「+ 新对话」（高频主入口，占整行、靠位置不靠填充色）+ 搜索（低频）。
          搜索点开：icon 原地不动，输入框从 icon 向左展开盖住整行（动画 left，px↔calc 可插值）。 */}
      <div className="px-2 pb-1.5 pt-2">
        <div className="relative flex h-8 items-center">
          {/* 与下方会话行同刻度（h-8 / gap-2 / px-2.5 / hover:bg-hover），icon 列纵向对齐 */}
          <button
            type="button"
            onClick={() => setActive(agentId, null)}
            tabIndex={searchOpen ? -1 : 0}
            className={cn(
              // mr-8 让出右端搜索 icon 那 32px 列——否则 flex-1 占满整行，hover 底色会一直铺到 icon 底下
              'mr-8 flex h-8 flex-1 items-center gap-2 rounded-md px-2.5 text-left text-sm text-text-secondary transition-opacity duration-200 ease-out hover:bg-hover hover:text-text-primary',
              searchOpen && 'pointer-events-none opacity-0',
            )}
          >
            <Plus size={14} strokeWidth={2} />
            <span>{t('newConv')}</span>
          </button>
          <div
            className={cn(
              'absolute inset-y-0 right-0 flex items-center rounded-md border transition-[left,background-color,border-color] duration-200 ease-out',
              searchOpen
                ? 'oru-lamp left-0 border-border bg-elevated focus-within:border-lamp-line focus-within:shadow-focus'
                : 'left-[calc(100%-32px)] border-transparent', // 32px = 右端 icon 按钮的 w-8：收起时恰好只露 icon
            )}
          >
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  // Esc 只关搜索框——不冒泡到 document，免得把随手评点浮层一起关了（同 RenameInput）
                  e.stopPropagation();
                  closeSearch();
                }
              }}
              tabIndex={searchOpen ? 0 : -1}
              placeholder={t('searchPlaceholder')}
              className={cn(
                'h-full min-w-0 flex-1 bg-transparent pl-2.5 text-sm text-text-primary outline-none transition-opacity duration-200 placeholder:text-text-tertiary',
                !searchOpen && 'pointer-events-none opacity-0',
              )}
            />
            <button
              type="button"
              aria-label={t('searchAria')}
              aria-expanded={searchOpen}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              className={cn(
                'flex h-full w-8 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:text-text-primary',
                !searchOpen && 'hover:bg-hover',
              )}
            >
              <Search size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>

      {/* 列表 / 搜索结果（自滚）。scrollbar-gutter:stable 恒定预留 10px 滚动槽——配合全站「透明常态、
          hover 浮现」的 thumb，滚动条只在 hover/滚动时可见，且出现/消失不再挤动文字（同 ChatArea）。 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-gutter:stable]">
        {inSearch ? (
          <SearchResults
            groups={results}
            query={trimmedQuery}
            activeId={activeId}
            onOpenTop={(id) => setActive(agentId, id)}
            onOpenAt={(id, msgId) => openConversationAt(agentId, id, msgId)}
          />
        ) : (
          <TimeLog agentId={agentId} list={list} controls={controls} />
        )}
      </div>

      {/* 归档确认（活跃行 X）：可勾「不再提醒」直接置 confirmBeforeArchive=false */}
      <ArchiveConfirm
        conv={pendingArchive}
        onClose={() => setPendingArchive(null)}
        onConfirm={(dontAskAgain) => {
          if (pendingArchive) void archive(agentId, pendingArchive.id);
          if (dontAskAgain) void updateSettings({ confirmBeforeArchive: false });
          setPendingArchive(null);
        }}
      />

      {/* 彻底删除确认（已归档行）：不可逆，复用通用 DeleteConfirm（danger） */}
      <DeleteConfirm
        open={pendingDelete !== null}
        title={pendingDelete ? t('deleteTitle', { title: pendingDelete.title }) : t('deleteTitleFallback')}
        description={t('deleteDesc')}
        confirmLabel={t('deletePermanent')}
        onConfirm={() => {
          if (pendingDelete) void remove(agentId, pendingDelete.id);
          setPendingDelete(null);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}

/**
 * 归档确认弹窗——活跃对话的 X 触发。归档是安全可逆动作，故用 primary（非 danger）。
 * 「不再提醒」勾选随每次打开重置；勾了并确认才落 confirmBeforeArchive=false（取消不持久化）。
 */
function ArchiveConfirm({
  conv,
  onClose,
  onConfirm,
}: {
  conv: Conversation | null;
  onClose: () => void;
  onConfirm: (dontAskAgain: boolean) => void;
}) {
  const { t } = useTranslation('conversation');
  const [dontAskAgain, setDontAskAgain] = useState(false);
  useEffect(() => {
    if (conv) setDontAskAgain(false);
  }, [conv]);

  return (
    <Dialog
      open={conv !== null}
      onClose={onClose}
      title={conv ? t('archiveTitle', { title: conv.title }) : t('archiveTitleFallback')}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => onConfirm(dontAskAgain)}>
            {t('archive')}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-text-secondary">
        {t('archiveBody')}
      </p>
      <label className="mt-3 flex cursor-pointer select-none items-center gap-2 text-xs text-text-tertiary">
        <input
          type="checkbox"
          checked={dontAskAgain}
          onChange={(e) => setDontAskAgain(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-border accent-accent"
        />
        {t('dontAskAgain')}
      </label>
    </Dialog>
  );
}

/** 时间日志：活跃对话按今天 / 本周 / 更早分段；已归档对话另收进「已归档」抽屉 */
function TimeLog({
  agentId,
  list,
  controls,
}: {
  agentId: string;
  list: Conversation[];
  controls: RowControls;
}) {
  const { t } = useTranslation('conversation');
  // 分组（活跃分桶 today/week/earlier + 已归档）走共享纯函数——与定时任务对话选择器同一份。
  // 「正在看的对话」即便已归档也留活跃区（前端显示兜底），切走后下次渲染才真正沉入已归档。
  // 待办不再浮顶（2026-07-19 UI/UX 改造 骨-3 拍板）：黄点行直接留在原时间分区内，
  // 待办信号交给通知中心统一承载；会话列表里再抽一个浮顶分区是第二处表达、且打断时间分组连续性。
  // 不变量「黄点集合 = 通知中心待处理集合」不受影响——只是列表内不再单独分区。
  const byBucket = useMemo(
    () => groupConversations(list, { activeId: controls.activeId }),
    [list, controls.activeId],
  );
  const archivedSubs = byBucket.archived;

  // 空态：四个桶全空才显示（含已归档）——否则「还没有对话」会与下方「已归档」抽屉并列自相矛盾。
  // 注：ArchivedDrawer 另异步拉随手评点(aside)，TimeLog 这层看不到；仅有 aside、四桶皆空的边缘
  // 会短暂并列，属可接受边界（主场景「全部归档」已覆盖）。
  const isEmpty =
    byBucket.today.length === 0 &&
    byBucket.week.length === 0 &&
    byBucket.earlier.length === 0 &&
    byBucket.archived.length === 0;

  return (
    <div className="flex flex-col gap-0.5">
      {/* 今天恒展开（最该一眼看到）；本周可收起，默认收起 */}
      {byBucket.today.length ? (
        <div className="flex flex-col gap-0.5">
          <SegLabel>{bucketLabel('today', t)}</SegLabel>
          {byBucket.today.map((c) => (
            <ConvRow key={c.id} conv={c} controls={controls} />
          ))}
        </div>
      ) : null}
      <WeekSection agentId={agentId} weekSubs={byBucket.week} controls={controls} />
      <EarlierDrawer agentId={agentId} earlierSubs={byBucket.earlier} controls={controls} />
      <ArchivedDrawer agentId={agentId} archivedSubs={archivedSubs} controls={controls} />
      {isEmpty ? (
        <div className="px-2 py-6 text-center text-xs text-text-tertiary">{t('empty')}</div>
      ) : null}
    </div>
  );
}

/** 折叠收纳抽屉骨架：顶部 border + 计数标题 + chevron 动画 + 展开内容。更早 / 已归档共用 */
function CollapsibleDrawer({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mt-2 border-t border-border pt-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary"
      >
        <ChevronRight
          size={13}
          strokeWidth={1.8}
          className={cn('shrink-0 transition-transform duration-150', open && 'rotate-90')}
        />
        <span>{title}</span>
        <span className="ml-auto tabular-nums">{count}</span>
      </button>
      {open ? <div className="flex flex-col gap-0.5">{children}</div> : null}
    </div>
  );
}

/**
 * 本周收纳区：本周内、未归档的对话。可折叠、默认收起（当前在看的对话若落在本周则初始展开，免得藏掉活跃行）。
 * 与更早/已归档同属"可折叠区"，故共用 CollapsibleDrawer 折叠头（同字号/chevron/计数），视觉一致；
 * 「今天」是唯一恒展开项，单独留 SegLabel 标签样式。
 */
function WeekSection({
  agentId,
  weekSubs,
  controls,
}: {
  agentId: string;
  weekSubs: Conversation[];
  controls: RowControls;
}) {
  const { t } = useTranslation('conversation');
  // 默认收起；但正在看的对话若落在本周就展开——否则活跃高亮行会被折叠藏起来。
  const [open, setOpen] = useState(() => weekSubs.some((c) => c.id === controls.activeId));
  // 仅切 agent 时按新分身的当前对话重判（依赖只列 agentId：同 agent 内的列表/active 变化不重置，
  // 免得覆盖用户手动折叠）
  useEffect(() => {
    setOpen(weekSubs.some((c) => c.id === controls.activeId));
  }, [agentId]);

  if (weekSubs.length === 0) return null;

  return (
    <CollapsibleDrawer
      title={bucketLabel('week', t)}
      count={weekSubs.length}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {weekSubs.map((c) => (
        <ConvRow key={c.id} conv={c} controls={controls} />
      ))}
    </CollapsibleDrawer>
  );
}

/** 更早收纳区：早于本周、且未归档的普通对话（归档的另见「已归档」，不再混随手评点） */
function EarlierDrawer({
  agentId,
  earlierSubs,
  controls,
}: {
  agentId: string;
  earlierSubs: Conversation[];
  controls: RowControls;
}) {
  const { t } = useTranslation('conversation');
  const [open, setOpen] = useState(false);
  // 切 agent 收回折叠
  useEffect(() => {
    setOpen(false);
  }, [agentId]);

  if (earlierSubs.length === 0) return null;

  return (
    <CollapsibleDrawer
      title={bucketLabel('earlier', t)}
      count={earlierSubs.length}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {earlierSubs.map((c) => (
        <ConvRow key={c.id} conv={c} controls={controls} />
      ))}
    </CollapsibleDrawer>
  );
}

/** 已归档收纳区：归档的普通对话（archivedAt）+ 全部随手评点（aside） */
function ArchivedDrawer({
  agentId,
  archivedSubs,
  controls,
}: {
  agentId: string;
  archivedSubs: Conversation[];
  controls: RowControls;
}) {
  const { t } = useTranslation('conversation');
  const [open, setOpen] = useState(false);
  const asides = useConversationStore((s) => s.archivedByAgent[agentId] ?? EMPTY_CONVS);
  const fetchArchived = useConversationStore((s) => s.fetchArchived);

  // 进列表就拉一次随手评点：好知道抽屉该不该出现、计数准——否则"只有今天对话 + 磁盘上有
  // aside"时抽屉不渲染、aside 永远捞不回。切 agent 重拉并收回折叠。
  useEffect(() => {
    setOpen(false);
    void fetchArchived(agentId);
  }, [agentId, fetchArchived]);

  // 归档 sub + aside 混排，按"进归档区时间"倒序：sub 用 archivedAt（被收起的时刻），
  // aside 无归档动作、回退用 updatedAt（最后活动时刻）。
  const items = useMemo(() => {
    const key = (c: Conversation) => c.archivedAt ?? c.updatedAt;
    return [...archivedSubs, ...asides].sort((a, b) => key(b) - key(a));
  }, [archivedSubs, asides]);

  // 抽屉为空（无归档对话、无随手评点）就不渲染——不留空抽屉占位
  if (items.length === 0) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void fetchArchived(agentId); // 展开再拉一次保新鲜（其间可能新增 aside）
  };

  return (
    <CollapsibleDrawer title={bucketLabel('archived', t)} count={items.length} open={open} onToggle={toggle}>
      {/* 归档 sub 可改名/彻底删除/点开恢复；随手评点 readOnly。来源图标已区分（星光 vs 普通） */}
      {items.map((c) => (
        <ConvRow
          key={c.id}
          conv={c}
          controls={controls}
          readOnly={c.kind === 'aside'}
          permanent={c.kind !== 'aside'}
        />
      ))}
    </CollapsibleDrawer>
  );
}

/**
 * 一行对话。普通行 hover 出重命名 + 归档（已归档区则是彻底删除）、可进编辑态；readOnly 行
 * （随手评点）只可点开、来源靠星光图标标识，不出操作按钮。两类共用同一套行视觉，改一处不漏另一处。
 */
function ConvRow({
  conv,
  controls,
  readOnly = false,
  permanent = false,
}: {
  conv: Conversation;
  controls: RowControls;
  readOnly?: boolean;
  /** 在「已归档」区为 true：动作是彻底删除（Trash2）而非归档（Archive） */
  permanent?: boolean;
}) {
  const { t } = useTranslation('conversation');
  const { activeId, editingId, setEditingId, badgeByConv, onOpen, onRename, onArchive, onDelete } =
    controls;
  const isActive = conv.id === activeId;
  const isEditing = !readOnly && editingId === conv.id;
  const badge = badgeByConv[conv.id];

  return (
    <div
      className={cn(
        // 设计稿 4a 会话行：定高 32px + px-10 + 圆角（活跃 accent-soft）
        'group flex h-8 items-center gap-2 rounded-md px-2.5 text-left text-sm transition-colors',
        isActive ? 'bg-accent-soft text-text-primary' : 'text-text-secondary hover:bg-hover',
      )}
    >
      {/* 图标类别走共享组件（与定时任务对话选择器同一份）：随手评点=星光 / 平台来源=纸飞机 / 否则=气泡 */}
      <ConversationIcon conv={conv} />
      {isEditing ? (
        <RenameInput
          initial={conv.title}
          onCommit={(next) => {
            setEditingId(null);
            const trimmed = next.trim();
            if (trimmed && trimmed !== conv.title) onRename(conv.id, trimmed);
          }}
          onCancel={() => setEditingId(null)}
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => onOpen(conv.id)}
            className="flex min-w-0 flex-1 items-center text-left"
          >
            <span className="min-w-0 flex-1 truncate">{conv.title}</span>
          </button>
          {/*
           * 右侧元区——状态点贴最右成列，安静的行那一列就是空白；时间交给分组小标题，不在行里重复。
           * 非随手评点的行 hover 时状态点让位给重命名 / 删除。
           */}
          <div className="flex shrink-0 items-center gap-2">
            <span className={cn('flex w-2 justify-center', !readOnly && 'group-hover:hidden')}>
              <ConvBadgeDot badge={badge} />
            </span>
            {readOnly ? null : (
              <div className="hidden items-center gap-2 group-hover:flex">
                <button
                  type="button"
                  aria-label={t('renameAria', { title: conv.title })}
                  onClick={() => setEditingId(conv.id)}
                  className="text-text-tertiary hover:text-text-primary"
                >
                  <Pencil size={12} strokeWidth={1.5} />
                </button>
                {permanent ? (
                  <button
                    type="button"
                    aria-label={t('deleteAria', { title: conv.title })}
                    onClick={() => onDelete(conv)}
                    className="text-text-tertiary hover:text-danger"
                  >
                    <Trash2 size={12} strokeWidth={1.5} />
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={t('archiveAria', { title: conv.title })}
                    onClick={() => onArchive(conv)}
                    className="text-text-tertiary hover:text-text-primary"
                  >
                    <Archive size={12} strokeWidth={1.5} />
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 搜索结果：按对话聚合命中，点标题进对话顶部、点命中片段跳到那条消息 */
function SearchResults({
  groups,
  query,
  activeId,
  onOpenTop,
  onOpenAt,
}: {
  groups: ConvSearchHit[] | null;
  query: string;
  activeId: string | null;
  onOpenTop: (convId: string) => void;
  onOpenAt: (convId: string, messageId: string) => void;
}) {
  const { t } = useTranslation('conversation');
  if (groups === null) {
    return <div className="px-2 py-6 text-center text-xs text-text-tertiary">{t('searching')}</div>;
  }
  if (groups.length === 0) {
    return (
      <div className="px-2 py-6 text-center text-xs text-text-tertiary">
        {t('noResults', { query })}
      </div>
    );
  }
  const totalHits = groups.reduce((n, g) => n + g.messages.length, 0);
  return (
    <div className="flex flex-col gap-1">
      <div className="px-2 pb-1 pt-1 text-xs text-text-tertiary">
        <Trans
          i18nKey="searchSummary"
          ns="conversation"
          values={{ convs: groups.length, hits: totalHits }}
          components={{ b: <b className="font-semibold text-text-secondary" /> }}
        />
      </div>
      {groups.map((g) => (
        <div key={g.conversation.id} className="flex flex-col">
          <button
            type="button"
            onClick={() => onOpenTop(g.conversation.id)}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-hover',
              g.conversation.id === activeId && 'bg-accent-soft',
            )}
          >
            <MessageSquare size={13} strokeWidth={1.5} className="shrink-0 text-text-tertiary" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
              <Highlighted text={g.conversation.title} query={query} />
            </span>
            {g.messages.length ? (
              <span className="shrink-0 rounded-full bg-accent-soft px-1.5 font-mono text-2xs text-accent">
                {g.messages.length}
              </span>
            ) : null}
          </button>
          {g.messages.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onOpenAt(g.conversation.id, m.id)}
              className="ml-3 flex items-baseline gap-1.5 rounded-r-md border-l-[1.5px] border-border py-1 pl-3 pr-2 text-left text-xs leading-relaxed text-text-secondary transition-colors hover:border-accent-ring hover:bg-hover"
            >
              <span className="shrink-0 text-2xs text-text-tertiary">
                {m.role === 'user' ? t('roleUser') : 'Oru'}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <SnippetText text={m.text} query={query} />
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 整段高亮（标题用）：命中词包 <mark> */
function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitHighlight(text, query).map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-text-primary">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/** 命中消息的上下文片段：两头按需 …，命中词包 <mark> */
function SnippetText({ text, query }: { text: string; query: string }) {
  const s = snippet(text, query);
  return (
    <>
      {s.ellipsisStart ? '…' : ''}
      {s.pre}
      {s.hit ? (
        <mark className="rounded-sm bg-accent-soft px-0.5 text-text-primary">{s.hit}</mark>
      ) : null}
      {s.post}
      {s.ellipsisEnd ? '…' : ''}
    </>
  );
}

/** Inline rename 输入框：autoFocus + 全选；Enter / blur 提交，Esc 取消 */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return; // 输入法选词态回车不提交
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(draft);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
        // 让 e 在编辑态内是普通字符输入而不是再次触发重命名
        e.stopPropagation();
      }}
      className="min-w-0 flex-1 rounded-sm border border-accent bg-elevated px-1 text-sm text-text-primary outline-none ring-2 ring-accent-ring"
    />
  );
}

/**
 * 对话状态标记（四态，与通知中心同一处判定的精简投影）：
 * - 待办（warn 黄点）——有要你处理的（审批 / 问你 / 报错 / 错过）。最高优先。
 * - 进行中（accent 赤陶呼吸点）——Oru 还在这条里跑。
 * - 未读（accent 静止小点）——有你还没验收的完成结果；点开看过自动消失。
 * - 无——看过 / 普通历史，不标。
 * 待办用 warn、其余用 accent（沿用项目语义色，不引入新色）；呼吸 vs 静止 + 尺寸区分进行中 / 未读。
 */
function ConvBadgeDot({ badge }: { badge: ConvBadge | undefined }) {
  const { t } = useTranslation('conversation');
  if (!badge || badge === 'none') return null;
  if (badge === 'todo') {
    return <span className="h-2 w-2 shrink-0 rounded-full bg-warn" title={t('badgeTodo')} />;
  }
  if (badge === 'running') {
    return (
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" title={t('badgeRunning')} />
    );
  }
  // unread：同 accent 但更小、不呼吸（与进行中区分，避免再引入第三种颜色）
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t('badgeUnread')} />;
}

/** 时间分段小标题（今天恒展开专用；本周/更早/已归档走 CollapsibleDrawer 的折叠头） */
function SegLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-3 font-mono text-2xs uppercase tracking-wider text-text-tertiary">
      {children}
    </div>
  );
}
