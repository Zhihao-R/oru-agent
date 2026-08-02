/**
 * 着陆面（Home + Memory 合并）——对话区在「无活跃对话」时的空态，非独立页。
 *
 * 首屏 = 启动器（垂直居中：头像 / 欢迎语 / 输入栏 / 最近对话）；下滚吸附进「手账」，
 * 手账四节（昨夜 / 关于你 / 关于小知 / 正在做的 / 笔记）章节给摘要、全文走浮层；左侧滚动目录。
 * 组件自给自足：数据自拉、focus 自读 memoryStore 消费、提交自建对话（setActive 后 ChatArea 自切消息流）。
 * 设计定稿见 UIUX重构参考/交接-主页/，执行清单 docs/plans/2026-07-20-ui-ux-主页-执行清单.md。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_NEW_CONV_TITLE } from '@shared/types';
import { useMemoryStore } from '@/stores/memoryStore';
import { useProjectStore } from '@/stores/projectStore';
import { useAgentStore } from '@/stores/agentStore';
import { useUserProfileStore } from '@/stores/userProfileStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useChatStore, composerKey } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { resolveOruName } from '@/lib/oruName';
import { parseChangelog } from '@/components/memory/changelogParse';
import { useHomeScroll } from '@/hooks/useHomeScroll';
import { useLandingNavStore } from '@/stores/landingNavStore';
import { Launcher, type RecentChat } from '@/components/home/Launcher';
import { NightSection } from '@/components/home/sections/NightSection';
import { AboutSection } from '@/components/home/sections/AboutSection';
import { ProjectsSection } from '@/components/home/sections/ProjectsSection';
import { NotesSection } from '@/components/home/sections/NotesSection';
import { TableOfContents, HOME_SECTION_IDS, ANCHOR_TOP_OFFSET } from '@/components/home/TableOfContents';
import { AddProjectDialog } from '@/components/AddProjectDialog';
import { EditProfileOverlay } from '@/components/home/overlays/EditProfileOverlay';
import { NoteDetailOverlay } from '@/components/home/overlays/NoteDetailOverlay';
import { AboutFullOverlay } from '@/components/home/overlays/AboutFullOverlay';
import { ProjectDetailOverlay } from '@/components/home/overlays/ProjectDetailOverlay';
import { PastNightsOverlay } from '@/components/home/overlays/PastNightsOverlay';
import { FilterOverlay } from '@/components/home/overlays/FilterOverlay';
import { EMPTY_FILTER, type HomeOverlay, type NoteFilter } from '@/components/home/homeTypes';
import { monthDayParts } from '@/components/home/homeDate';

const USER_PROFILE_PATH = 'user/profile.md';
const SELF_PROFILE_PATH = 'agents/twin/self.md';

export default function HomeLanding() {
  const { t } = useTranslation('home');

  // ── 数据 ──
  const episodes = useMemoryStore((s) => s.episodes);
  const changelog = useMemoryStore((s) => s.changelog);
  const memProjects = useMemoryStore((s) => s.projects);
  const projectProfileByPid = useMemoryStore((s) => s.projectProfileByPid);
  const docLastUpdatedByPath = useMemoryStore((s) => s.docLastUpdatedByPath);
  const fetchEpisodes = useMemoryStore((s) => s.fetchEpisodes);
  const fetchRetiredEpisodes = useMemoryStore((s) => s.fetchRetiredEpisodes);
  const fetchChangelog = useMemoryStore((s) => s.fetchChangelog);
  const fetchProjects = useMemoryStore((s) => s.fetchProjects);
  const fetchProjectProfile = useMemoryStore((s) => s.fetchProjectProfile);
  const runDream = useMemoryStore((s) => s.runDream);

  const activeAgent = useAgentStore((s) => s.agents.find((a) => a.id === s.activeAgentId) ?? null);
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const oruName = resolveOruName(activeAgent?.name);
  const userProfile = useUserProfileStore((s) => s.profile);
  const userName = userProfile?.name ?? t('about.you');

  const convByAgent = useConversationStore((s) => (activeAgentId ? s.byAgent[activeAgentId] : undefined));
  const refreshConvs = useConversationStore((s) => s.refresh);
  const setActive = useConversationStore((s) => s.setActive);
  const createConversation = useConversationStore((s) => s.create);
  const send = useChatStore((s) => s.send);
  const migrateComposerRefs = useChatStore((s) => s.migrateComposerRefs);
  const switchProject = useProjectStore((s) => s.switchProject);
  const refreshProjects = useProjectStore((s) => s.refresh);
  const authReady = useSettingsStore((s) => s.authStatus.ready);

  // ── 首次进页全量重拉（dream 在后台跑，缓存会陈旧）──
  // projectStore（项目注册表，供项目名解析）自拉一次：开屏可能直接落在主页、侧栏未挂载时它还空着。
  useEffect(() => {
    void fetchEpisodes();
    void fetchRetiredEpisodes();
    void fetchChangelog();
    void fetchProjects();
    void refreshProjects();
  }, [fetchEpisodes, fetchRetiredEpisodes, fetchChangelog, fetchProjects, refreshProjects]);

  useEffect(() => {
    for (const p of memProjects) void fetchProjectProfile(p.projectId);
  }, [memProjects, fetchProjectProfile]);

  useEffect(() => {
    if (activeAgentId) void refreshConvs(activeAgentId);
  }, [activeAgentId, refreshConvs]);

  // ── 滚动叙事 ──
  const { scrollRef, journalRef, sc, launcherMinH, journalFadePx, tocVisible, onScroll, snapToJournal, scrollToTop } =
    useHomeScroll();

  // 右栏有文件预览时对话区被压窄，正文左移会撞上钉在 left-[30px] 的目录——此时整条隐去。
  const previewOpen = useWorkspaceStore((s) => s.openTabs.length > 0);

  // 视口底缘渐隐带：把浮现的手账预览往透明里揉，滚进手账后（journalFadePx→0）撤除、正文不削。
  const fadeMask =
    journalFadePx > 0
      ? `linear-gradient(to bottom, #000 calc(100% - ${journalFadePx}px), transparent)`
      : undefined;

  // ── 顶栏点「手账」的滚动请求：吸附到手账区（≈ 昨夜），消费即清 ──
  // 冷启动 line 初始 memory、无 scrollRequest → 挂载停顶部启动器（重启落输入框）；点手账走
  // requestScroll('memory') → snapToJournal 落昨夜。当前线点击驱动，此处不再滚动派生高亮。
  const scrollRequest = useLandingNavStore((s) => s.scrollRequest);
  const consumeScroll = useLandingNavStore((s) => s.consumeScroll);
  // 全局 scrollRequest 只作一次性触发：立即转本地待办 + 消费（不把它留在全局 store 里残留、
  // 污染下次挂载）。本地待办等启动器高度（launcherMinH）就绪后再定位——刚从消息流挂载时它未
  // 测得，此刻 journalRef.offsetTop 是塌缩值，直接滚会落到「不上不下」。
  const [pendingSnap, setPendingSnap] = useState<'chat' | 'memory' | null>(null);
  useEffect(() => {
    if (!scrollRequest) return;
    setPendingSnap(scrollRequest);
    consumeScroll();
  }, [scrollRequest, consumeScroll]);
  useEffect(() => {
    if (!pendingSnap || launcherMinH == null) return;
    // 'auto' 瞬时滚——程序化 smooth 在刚挂载时落不到位。
    if (pendingSnap === 'memory') snapToJournal('auto');
    else scrollToTop();
    setPendingSnap(null);
  }, [pendingSnap, launcherMinH, snapToJournal, scrollToTop]);

  // ── 浮层 / 筛选 ──
  const [overlay, setOverlay] = useState<HomeOverlay | null>(null);
  const [filter, setFilter] = useState<NoteFilter>(EMPTY_FILTER);
  const [addProjectOpen, setAddProjectOpen] = useState(false);

  const nights = useMemo(() => parseChangelog(changelog ?? ''), [changelog]);
  const hasEpisodes = episodes.length > 0;

  // 目录锚点 = 实际渲染的内容节：「笔记」仅在有昨夜记录时渲染，无则从目录剔除（否则点它找不到锚点）。
  const tocSections = useMemo(
    () => (hasEpisodes ? HOME_SECTION_IDS : HOME_SECTION_IDS.filter((s) => s !== 'notes')),
    [hasEpisodes],
  );

  // 尾部留白：目录点任一锚点都应能把该节滚到容器顶。靠底的节后方内容不足一屏时，goto 的目标
  // 滚动量被浏览器钳住 → 节停在半空、够不到高亮判定线（「正在做的」点了没反应即此）。据「最后一个
  // 锚点节到内容底的高度」反推需补的留白，补到该节置顶时其下方恰好一屏——能置顶又不留多余空白。
  // spacer 特意放在 innerRef（纯内容）之外：测量只观测内容与视口，不观测自己撑的留白，故无自反馈。
  const innerRef = useRef<HTMLDivElement>(null);
  const [tailPad, setTailPad] = useState(0);
  const lastSectionId = tocSections[tocSections.length - 1];
  useLayoutEffect(() => {
    const c = scrollRef.current;
    const inner = innerRef.current;
    if (!c || !inner) return;
    const recompute = () => {
      const last = document.getElementById(`home-sec-${lastSectionId}`);
      if (!last) return;
      const cTop = c.getBoundingClientRect().top;
      const lastTop = last.getBoundingClientRect().top - cTop + c.scrollTop;
      const contentBottom = inner.getBoundingClientRect().bottom - cTop + c.scrollTop; // 纯内容底（不含 spacer）
      const needed = Math.max(0, c.clientHeight - (contentBottom - lastTop) - ANCHOR_TOP_OFFSET);
      setTailPad((prev) => (Math.abs(prev - needed) > 1 ? needed : prev));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(inner); // 内容高变（数据异步到达）
    ro.observe(c); // 视口高变
    return () => ro.disconnect();
  }, [scrollRef, lastSectionId]);

  // 档案「修订 MM·DD」（C5）：last-updated（YYYY-MM-DD）→ MM·DD
  const revisionOf = (relPath: string): string | null => {
    const p = monthDayParts(docLastUpdatedByPath[relPath]);
    return p ? `${p[0]}·${p[1]}` : null;
  };
  const userRevision = revisionOf(USER_PROFILE_PATH);
  const selfRevision = revisionOf(SELF_PROFILE_PATH);

  // ── 最近对话 ×3（活跃 sub，按 updatedAt 倒序）──
  const recentChats: RecentChat[] = useMemo(() => {
    if (!activeAgentId) return [];
    return (convByAgent ?? [])
      .filter((c) => c.kind === 'sub')
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3)
      .map((c) => ({
        id: c.id,
        title: c.title || DEFAULT_NEW_CONV_TITLE,
        onOpen: () => {
          setActive(activeAgentId, c.id);
        },
      }));
  }, [convByAgent, activeAgentId, setActive]);

  // ── 启动器发送：新建对话 → 带文本/附件切对话页 ──
  const onLauncherSubmit = (text: string, attachments?: Parameters<typeof send>[1]) => {
    if (!activeAgentId) return;
    void (async () => {
      const created = await createConversation(activeAgentId, DEFAULT_NEW_CONV_TITLE);
      if (!created) return;
      const draftKey = composerKey(activeAgentId, null);
      if (draftKey) migrateComposerRefs(draftKey, created.id);
      setActive(activeAgentId, created.id);
      void send(text, attachments);
    })();
  };

  // ── 开工：切项目 + 新建对话 + 进对话页（进展上下文随活跃项目由 Oru 读 profile.md 承载）──
  const onStartProject = (projectId: string) => {
    if (!activeAgentId) return;
    void (async () => {
      await switchProject(projectId);
      const created = await createConversation(activeAgentId, DEFAULT_NEW_CONV_TITLE);
      if (created) setActive(activeAgentId, created.id);
      setOverlay(null);
    })();
  };

  // ── 查看原文（E4 一期）：切到来源对话并进对话页 ──
  const onViewSource = (convId: string) => {
    if (!activeAgentId) return;
    setActive(activeAgentId, convId);
    setOverlay(null);
  };

  const onRunDream = async (): Promise<boolean> => {
    const ok = await runDream();
    if (ok) void fetchChangelog();
    return ok;
  };

  return (
    <div data-aside-region="chat" className="relative flex h-full min-h-0 flex-col overflow-hidden bg-canvas">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="oru-home-scroll min-h-0 flex-1 overflow-y-auto"
        style={{ WebkitMaskImage: fadeMask, maskImage: fadeMask }}
      >
        <div ref={innerRef} className="mx-auto max-w-[680px] px-7 pb-[90px]">
          <Launcher
            oruName={oruName}
            oruAvatarPath={activeAgent?.avatarPath ?? null}
            recentChats={recentChats}
            agentId={activeAgentId}
            disabled={!activeAgentId || !authReady}
            minH={launcherMinH}
            onEditProfile={() => setOverlay({ kind: 'editProfile' })}
            onSnap={() => snapToJournal()}
            onSubmit={onLauncherSubmit}
          />

          <div
            ref={journalRef}
            data-aside-region="memory"
            className="mt-2"
            style={{ cursor: sc < 200 ? 'pointer' : 'auto' }}
            // 首屏时（还没滚进手账）点击下方预览区 → 丝滑吸附到手账，不触发内部条目（capture 阶段拦截）
            onClickCapture={(e) => {
              if (sc < 200) {
                e.stopPropagation();
                snapToJournal();
              }
            }}
          >
            <div id="home-sec-night">
              <NightSection
                nights={nights}
                hasEpisodes={hasEpisodes}
                onOpenNights={() => setOverlay({ kind: 'nights' })}
                onRunDream={onRunDream}
              />
            </div>

            <hr className="mt-[30px] h-px border-0 bg-border" />
            <div id="home-sec-about" className="mt-7">
              <AboutSection
                variant="user"
                relPath={USER_PROFILE_PATH}
                name={userName}
                avatarPath={userProfile?.avatarPath ?? null}
                revisionDate={userRevision}
                onEditProfile={() => setOverlay({ kind: 'editProfile' })}
                onExpand={() => setOverlay({ kind: 'aboutYou' })}
              />
            </div>
            <div className="mt-[42px]">
              <AboutSection
                variant="self"
                relPath={SELF_PROFILE_PATH}
                name={oruName}
                avatarPath={activeAgent?.avatarPath ?? null}
                revisionDate={selfRevision}
                onEditProfile={() => setOverlay({ kind: 'editProfile' })}
                onExpand={() => setOverlay({ kind: 'aboutSelf' })}
              />
            </div>

            <hr className="mt-[30px] h-px border-0 bg-border" />
            <div id="home-sec-projects" className="mt-7">
              <ProjectsSection
                projects={memProjects}
                profileByPid={projectProfileByPid}
                onOpenProject={(projectId) => setOverlay({ kind: 'project', projectId })}
                onAddProject={() => setAddProjectOpen(true)}
              />
            </div>

            {hasEpisodes && (
              <>
                <hr className="mt-[30px] h-px border-0 bg-border" />
                <div id="home-sec-notes" className="mt-7">
                  <NotesSection
                    filter={filter}
                    onOpenFilter={() => setOverlay({ kind: 'filter' })}
                    onOpenNote={(relPath) => setOverlay({ kind: 'note', relPath })}
                  />
                </div>
              </>
            )}

            {/* 落款沿用 memory 语义：小知 写于 …（保留现状文案） */}
            <Colophon oruName={oruName} />
          </div>
        </div>

        {/* 尾部留白：撑够高度让靠底的目录锚点也能滚到容器顶（值由上方 useLayoutEffect 测算）。
            放在 mx-auto 内容容器之外，使测量不观测到自身、避免自反馈。 */}
        <div aria-hidden style={{ height: tailPad }} />
      </div>

      {!previewOpen && (
        <TableOfContents visible={tocVisible} sc={sc} scrollRef={scrollRef} sections={tocSections} onTop={scrollToTop} />
      )}

      {/* ── 浮层 ── */}
      {overlay?.kind === 'editProfile' && <EditProfileOverlay onClose={() => setOverlay(null)} />}
      {overlay?.kind === 'note' && (
        <NoteDetailOverlay
          relPath={overlay.relPath}
          onClose={() => setOverlay(null)}
          onPickTag={(tag) => {
            setFilter({ type: null, tags: new Set([tag]) });
            setOverlay(null);
          }}
          onViewSource={onViewSource}
        />
      )}
      {overlay?.kind === 'aboutYou' && (
        <AboutFullOverlay variant="user" relPath={USER_PROFILE_PATH} name={userName} revisionDate={userRevision} onClose={() => setOverlay(null)} />
      )}
      {overlay?.kind === 'aboutSelf' && (
        <AboutFullOverlay variant="self" relPath={SELF_PROFILE_PATH} name={oruName} revisionDate={selfRevision} onClose={() => setOverlay(null)} />
      )}
      {overlay?.kind === 'project' && (
        <ProjectDetailOverlay projectId={overlay.projectId} onClose={() => setOverlay(null)} onStart={onStartProject} />
      )}
      {overlay?.kind === 'nights' && <PastNightsOverlay onClose={() => setOverlay(null)} />}
      {overlay?.kind === 'filter' && (
        <FilterOverlay
          filter={filter}
          onApply={(f) => {
            setFilter(f);
            setOverlay(null);
          }}
          onClose={() => setOverlay(null)}
        />
      )}

      {addProjectOpen && <AddProjectDialog open={addProjectOpen} onClose={() => setAddProjectOpen(false)} />}
    </div>
  );
}

function Colophon({ oruName }: { oruName: string }) {
  const { t } = useTranslation('memory');
  const d = new Date();
  return (
    <div className="mt-[52px] text-right font-serif text-[13px] tracking-[0.03em] text-text-tertiary">
      {t('colophon', { name: oruName, date: t('colophonDate', { month: d.getMonth() + 1, day: d.getDate() }) })}
    </div>
  );
}
