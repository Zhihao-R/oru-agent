import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsRight, SquareDashedMousePointer } from 'lucide-react';
import type { Annotation } from '@shared/types';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useChatStore } from '@/stores/chatStore';
import { groupAnnotations } from '@/lib/groupAnnotations';
import { AnnotCard } from '@/components/annot/AnnotCard';
import type { SubmissionSurface } from '@/components/annot/submissionSurface';

/**
 * 批注面板（框选卡列表，deck/html 共用壳，项目B 第三期 Task15）
 *
 * 从 AnnotPane 抽出：所有数据/动作走 `surface`（SubmissionSurface），deck/html 各注入接线。
 * 对话 composer 预填（submitAndPrefill / handleResume）走全局 conversation/chat store，deck/html 同构。
 *
 * 渲染分组（submission 驱动）：
 * - 活跃组「修改中」（afterVersionId 无）：组成员只读；[停止修改]+[标记完成]。
 * - 活跃组「完成」（afterVersionId 有）：[保存][对比][取消]。
 * - 「已中断」（崩溃后派生）：[继续]（切原对话+预填）+[退回改前]。
 * - 开放卡：pending + 独立 failed，按创建顺序列出。
 */
/** 按页码把开放卡分组，页序升序（无页码归 0 页）——演示稿评审层的 P{n} 分组。 */
function groupOpenByPage(
  numbered: { a: Annotation; num: number }[],
): { page: number; items: { a: Annotation; num: number }[] }[] {
  const byPage = new Map<number, { a: Annotation; num: number }[]>();
  for (const item of numbered) {
    const page = item.a.locator.pageIndex ?? 0;
    const bucket = byPage.get(page);
    if (bucket) bucket.push(item);
    else byPage.set(page, [item]);
  }
  return [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([page, items]) => ({ page, items }));
}

export function AnnotPanel({ surface }: { surface: SubmissionSurface }) {
  const { t } = useTranslation('annot');
  const { annotations, submission, cropBaseDir } = surface;
  const setActiveConv = useConversationStore((s) => s.setActive);
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const activeConvId = useConversationStore((s) =>
    activeAgentId ? s.activeByAgent[activeAgentId] ?? null : null,
  );
  const setDraftText = useChatStore((s) => s.setDraftText);
  const addAttachments = useChatStore((s) => s.addAttachments);

  // 分组（submission 驱动，纯函数见 groupAnnotations）
  const { activeGroup, openCards } = useMemo(
    () => groupAnnotations(annotations, submission),
    [annotations, submission],
  );

  // 勾选集合（本地 state）：仅 pending 卡可勾。提交后清空。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitError, setSubmitError] = useState<string | null>(null);
  // 标注列表变化时，剔除已不存在 / 已非 pending 的勾选项，避免提交陈旧 id
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const pendingIds = new Set(annotations.filter((a) => a.status === 'pending').map((a) => a.id));
      const next = new Set([...prev].filter((id) => pendingIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [annotations]);

  function toggle(id: string) {
    setSubmitError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * 提交一批标注 + 把诉求预填进指定对话的 composer（设计 §6.2）。提交（成组 + 转 submitted +
   * 改前 commit）在后端，前端只负责预填文案 + crop 附件、等用户手动发。
   * handleSubmit（新提交）与 handleResume（崩溃「继续」）共用，仅 ids/convId 来源不同（系统性）。
   */
  async function submitAndPrefill(ids: string[], convId: string): Promise<boolean> {
    const r = await surface.submitAnnotations(ids, convId);
    if (!r) {
      setSubmitError(t('submitConflict'));
      return false;
    }
    const lines = r.payload.map((p, i) => `- [#${i + 1}] ${p.comment}`).join('\n');
    // 预填引导语随界面语言（种子内容先例，用户已拍板）；用户写的 comment（lines）是数据原样保留。
    setDraftText(convId, `${t('prefillIntro')}\n\n${lines}`);
    // crop 截图作为图片附件注入 composer（用户手动发送）。base64 → File 经 data: URL fetch
    //（data: 不受 webSecurity 限制）。注入失败降级：comment 文案已在 composer。8 张上限由 addAttachments 兜。
    try {
      const settled = await Promise.allSettled(
        r.payload
          .filter((p) => p.cropBase64)
          .map(async (p) => {
            const blob = await (await fetch(`data:image/png;base64,${p.cropBase64}`)).blob();
            return new File([blob], `${p.annotationId}.png`, { type: 'image/png' });
          }),
      );
      const files = settled
        .filter((s): s is PromiseFulfilledResult<File> => s.status === 'fulfilled')
        .map((s) => s.value);
      if (files.length > 0) addAttachments(convId, files);
    } catch {
      /* 注入失败降级——comment 文案已预填进 composer */
    }
    return true;
  }

  async function handleSubmit() {
    if (!activeConvId || selected.size === 0) return;
    setSubmitError(null);
    const ok = await submitAndPrefill([...selected], activeConvId);
    if (ok) setSelected(new Set());
  }

  /**
   * 「继续」（崩溃中断组，PRD §六-6）：切回当初提交它的对话、把这批标注在**当前（半改）稿子**上
   * 重走一次正常提交 + 预填 composer 等用户手动发。不恢复 live 内存组（焦点/并发/幂等全由正常链路处理）。
   */
  async function handleResume(groupItems: Annotation[]) {
    const convId = submission?.conversationId;
    if (!convId) return;
    setSubmitError(null);
    if (!activeAgentId) {
      setSubmitError(t('pickConvFirst'));
      return;
    }
    setActiveConv(activeAgentId, convId);
    await submitAndPrefill(groupItems.map((a) => a.id), convId);
  }

  const hasCards = activeGroup != null || openCards.length > 0;

  // 开放卡编号（#N，与画面 pin 对应）用全局出现序，分组后仍稳定
  const numberedOpen = openCards.map((a, i) => ({ a, num: i + 1 }));
  // 演示稿（有页码）→ 按页分 P{n} 组；网页（无页码）→ 平铺
  const openHasPages = numberedOpen.some(({ a }) => a.locator.pageIndex != null);

  const renderOpenCard = ({ a, num }: { a: Annotation; num: number }) => (
    <AnnotCard
      key={a.id}
      annotation={a}
      cropBaseDir={cropBaseDir}
      index={num}
      checked={selected.has(a.id)}
      onToggle={a.status === 'pending' ? () => toggle(a.id) : null}
      onSaveComment={(text) => void surface.updateAnnotation(a.id, { comment: text })}
      onJump={() => surface.requestJump(a.locator)}
      onDelete={() => void surface.removeAnnotation(a.id)}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-canvas">
      {/* 顶栏跟预览对齐：px-4 py-2 + h-6 内部按钮，让两侧分隔线在同一水平线 */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-1.5">
          {surface.onCollapse ? (
            <button
              type="button"
              onClick={surface.onCollapse}
              title={t('collapseTitle')}
              aria-label={t('collapseTitle')}
              className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              <ChevronsRight size={14} strokeWidth={1.5} />
            </button>
          ) : null}
          <h3 className="text-sm font-medium text-text-primary">{t('heading')}</h3>
        </div>
        <div className="flex items-center gap-2">
          {/* 框选标注：点了发信号让预览进框选模式 */}
          <button
            type="button"
            onClick={() => surface.requestFrameSelect()}
            disabled={surface.comparing}
            title={t('frameSelectTitle')}
            className="flex h-6 items-center gap-1 rounded-md border border-border px-2 text-xs text-text-secondary hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SquareDashedMousePointer size={12} strokeWidth={1.6} />
            <span>{t('frameSelect')}</span>
          </button>
          <button
            type="button"
            disabled={selected.size === 0 || !activeConvId}
            onClick={() => void handleSubmit()}
            className="h-6 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('submit')}
          </button>
        </div>
      </div>

      {submitError && (
        <p className="shrink-0 border-b border-border px-4 py-1.5 text-xs text-warn">{submitError}</p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!hasCards ? (
          <div className="px-4 py-8 text-center text-xs text-text-tertiary">
            {t('empty')}
          </div>
        ) : (
          <div className="flex flex-col gap-3 px-3 py-3">
            {/* 活跃提交组（置顶）：修改中（accent）/ 已中断（warn）/ 完成（success） */}
            {activeGroup ? (
              <section
                className={`rounded-md border p-2 ${
                  activeGroup.kind === 'editing'
                    ? 'border-accent bg-accent-soft'
                    : activeGroup.kind === 'interrupted'
                      ? 'border-warn bg-warn-soft'
                      : 'border-success bg-success-soft'
                }`}
              >
                <div
                  className={`mb-2 px-1 text-2xs font-medium uppercase tracking-wider ${
                    activeGroup.kind === 'editing'
                      ? 'text-accent'
                      : activeGroup.kind === 'interrupted'
                        ? 'text-warn'
                        : 'text-success'
                  }`}
                >
                  {activeGroup.kind === 'interrupted'
                    ? t('status.interrupted')
                    : activeGroup.isNarrative
                      ? t('status.narrativeUpdate')
                      : activeGroup.kind === 'editing'
                        ? t('status.editing')
                        : t('status.done')}
                </div>

                {activeGroup.kind === 'interrupted' ? (
                  <p className="px-1 pb-1 text-xs leading-relaxed text-text-secondary">
                    {t('interruptedDesc')}
                  </p>
                ) : null}

                {/* 纯文稿更新组：说明正文（替代标注卡/空占位） */}
                {activeGroup.isNarrative ? (
                  <p className="px-1 py-2 text-xs leading-relaxed text-text-secondary">
                    {activeGroup.kind === 'editing' ? t('narrativeEditing') : t('narrativeDone')}
                  </p>
                ) : activeGroup.kind === 'done' && activeGroup.items.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-text-secondary">{t('allDone')}</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {activeGroup.items.map((a, i) => (
                      <AnnotCard
                        key={a.id}
                        annotation={a}
                        cropBaseDir={cropBaseDir}
                        index={i + 1}
                        checked={false}
                        onToggle={null}
                        onSaveComment={null}
                        onJump={() => surface.requestJump(a.locator)}
                        onDelete={null}
                      />
                    ))}
                  </ul>
                )}

                {activeGroup.kind === 'interrupted' ? (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleResume(activeGroup.items)}
                      className="h-6 flex-1 rounded-md border border-accent bg-accent-soft text-xs font-medium text-accent"
                    >
                      {t('resume')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void surface.discardInterrupted(activeGroup.groupId)}
                      className="h-6 flex-1 rounded-md border border-border bg-canvas text-xs text-text-secondary hover:bg-hover hover:text-danger"
                    >
                      {t('revertToBefore')}
                    </button>
                  </div>
                ) : activeGroup.kind === 'editing' ? (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void surface.stopSubmission(activeGroup.groupId)}
                      className="h-6 flex-1 rounded-md border border-border bg-canvas text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
                    >
                      {t('stopEditing')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void surface.manualFinalize(activeGroup.groupId)}
                      className="h-6 flex-1 rounded-md border border-accent bg-accent-soft text-xs text-accent"
                    >
                      {t('markDone')}
                    </button>
                  </div>
                ) : (
                  <>
                    {submission?.residualOnForceFinalize ? (
                      <p className="mb-2 px-1 text-xs text-warn">
                        {t('residual', { count: submission.residualOnForceFinalize })}
                      </p>
                    ) : null}
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void surface.saveSubmission(activeGroup.groupId)}
                        className="h-6 flex-1 rounded-md bg-success px-2 text-xs font-medium text-success-fg hover:opacity-90"
                      >
                        {t('common:save')}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          surface.comparingThisGroup
                            ? void surface.exitCompare()
                            : void surface.enterCompare(activeGroup.groupId)
                        }
                        className="h-6 flex-1 rounded-md border border-border bg-canvas text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
                      >
                        {surface.comparingThisGroup ? t('exitCompare') : t('compare')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void surface.cancelSubmission(activeGroup.groupId)}
                        className="h-6 flex-1 rounded-md border border-border bg-canvas text-xs text-text-secondary hover:bg-hover hover:text-danger"
                      >
                        {t('common:cancel')}
                      </button>
                    </div>
                  </>
                )}
              </section>
            ) : null}

            {/* 开放卡：pending + 独立 failed。演示稿按页 P{n} 分组（组头可跳页），网页平铺 */}
            {openCards.length > 0 &&
              (openHasPages ? (
                <div className="flex flex-col gap-2">
                  {groupOpenByPage(numberedOpen).map(({ page, items }) => (
                    <div key={page} className="flex flex-col">
                      <div className="flex items-center gap-1.5 px-1 pb-0.5">
                        <button
                          type="button"
                          onClick={() => surface.requestJump(items[0]!.a.locator)}
                          title={t('jumpTitle')}
                          className="font-mono text-2xs font-semibold text-text-tertiary transition-colors hover:text-accent-deep"
                        >
                          {t('pageGroup', { n: page + 1 })}
                        </button>
                        <span className="h-px flex-1 bg-border" />
                      </div>
                      <ul className="flex flex-col gap-1">{items.map(renderOpenCard)}</ul>
                    </div>
                  ))}
                </div>
              ) : (
                <ul className="flex flex-col gap-1">{numberedOpen.map(renderOpenCard)}</ul>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
