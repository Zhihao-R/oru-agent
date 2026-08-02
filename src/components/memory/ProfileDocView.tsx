/**
 * ProfileDocView — 档案文档通用视图（Plan3 Task1）
 * 封装「只读↔编辑 + 圆形工具条 + 完成/取消 + 历史 + accent 边编辑仪式」，
 * 通过插槽（footer / eyebrowExtra）支持不同档案场景定制。
 *
 * TODO(档案): discarded 撞车提示待 editorStore 暴露撞车信号后补（Task3 未置标）
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ArrowLeft, Pencil, History, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEditorStore, refKey } from '@/stores/editorStore';
import type { DocRef } from '@/stores/editorStore';
import { ProfileHistoryPopover } from '@/components/memory/ProfileHistoryPopover';
import { MdEditor } from '@/components/editor/MdEditor';
import { profileEditorTheme, profileHighlight } from '@/components/editor/profileEditorTheme';
import { Overlay } from '@/components/home/overlays/Overlay';

/** 圆形 icon 按钮（32px 命中区，hover 现 accent-soft 圆底，tooltip） */
function IconBtn({
  icon,
  tip,
  primary = false,
  onClick,
}: {
  icon: ReactNode;
  tip: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={tip}
      aria-label={tip}
      onClick={onClick}
      // primary（✓完成）实心 accent 圆、hover 加深；其余单 icon、hover 才浮浅绿圆底 + accent-deep 字色
      // accent-fg 不经 tailwind 暴露（见 tailwind.config 注），primary 字色走 inline var
      style={primary ? { color: 'var(--accent-fg)' } : undefined}
      className={
        primary
          ? 'flex h-8 w-8 items-center justify-center rounded-full bg-accent transition-colors hover:bg-accent-deep'
          : 'flex h-8 w-8 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-accent-soft hover:text-accent-deep'
      }
    >
      {icon}
    </button>
  );
}

export type ProfileDocViewProps = {
  relPath: string;
  title: string;            // 「关于你」/「关于 Oru 自己」/ 项目名
  eyebrow: string;          // 只读态眉标基文案（如「手账 · 档案」）
  eyebrowEditing: string;   // 编辑态眉标（如「手账 · 档案 · 编辑中」）
  onClose: () => void;      // 父层关闭（遮罩/×）
  width?: number;           // 默认 560
  footer?: ReactNode;       // 只读态脚注区
  eyebrowExtra?: ReactNode; // 眉标文字旁的额外信息（项目时间标签等，Task3 用）
};

export function ProfileDocView({
  relPath,
  title,
  eyebrow,
  eyebrowEditing,
  onClose,
  width = 560,
  footer,
  eyebrowExtra,
}: ProfileDocViewProps) {
  const { t } = useTranslation('home');

  // editorStore 接线
  const ref = useMemo<DocRef>(() => ({ kind: 'memory', relPath }), [relPath]);
  const key = refKey(ref);
  const st = useEditorStore((s) => s.files[key]);

  useEffect(() => {
    void useEditorStore.getState().openRef(ref);
  }, [key, ref]);

  const [editing, setEditing] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const baselineRef = useRef('');

  function enterEdit() {
    // 直读 store state（不依赖 React 渲染时机，确保拿到最新内容）
    baselineRef.current = useEditorStore.getState().files[key]?.content ?? '';
    setEditing(true);
  }

  async function done() {
    // 直读 store（不依赖 React 渲染时机），与 enterEdit() 保持一致
    if ((useEditorStore.getState().files[key]?.content ?? '') !== baselineRef.current) {
      await useEditorStore.getState().manualSnapshot(key);
    }
    setEditing(false);
  }

  async function cancel() {
    // 直读 store，避免 React 渲染帧滞后导致误判
    if ((useEditorStore.getState().files[key]?.content ?? '') !== baselineRef.current) {
      if (!window.confirm(t('aboutFull.discardConfirm'))) return;
    }
    // 先退出编辑态，切断 MdEditor onChange 输入源，再回写再 flush
    setEditing(false);
    useEditorStore.getState().setContent(key, baselineRef.current);
    await useEditorStore.getState().flush(key);
  }

  // × / 遮罩点击在编辑态 = 完成（内容已实时落盘，安全退）
  // done 失败时仍调 onClose，防止浮层卡死
  function handleClose() {
    if (editing) {
      void done().then(onClose, onClose);
    } else {
      onClose();
    }
  }

  const eyebrowText = editing ? eyebrowEditing : eyebrow;
  const content = st?.content ?? '';

  return (
    // 编辑态不改卡片阴影/边（用户定论：眉标「编辑中」+ 工具条已是足够信号，不要绿边绿环）
    <Overlay width={width} radius={4} onClose={handleClose} hideClose>
      <div className="relative">
        {/* 固定顶栏：眉标 + 工具条——sticky，滚动长档案时不动（工具条始终可点）。
            bg-elevated 让下方正文滚到它底下时被遮住；relative 供历史小气泡锚定 */}
        <div className="sticky top-0 z-20 flex items-center justify-between bg-elevated px-[42px] pb-3 pt-7">
          {/* 眉标文字 + 额外信息（项目时间标签等）同处左侧 */}
          <div className="flex items-baseline gap-3">
            <div className="font-mono text-[10px] tracking-[0.16em] text-text-quaternary">{eyebrowText}</div>
            {eyebrowExtra}
          </div>

          {/* 工具条：读态 ✎编辑 ⏱历史 ×关闭；编辑态 ←取消 ✓完成（无 ×，demo 定论）
              relative：历史小气泡从 ⏱ 下方弹出，锚在工具条行 */}
          <div className="relative flex items-center gap-1.5">
            {editing ? (
              <>
                <IconBtn
                  tip={t('aboutFull.cancel')}
                  icon={<ArrowLeft size={15} strokeWidth={2} />}
                  onClick={() => void cancel()}
                />
                <IconBtn
                  tip={t('aboutFull.done')}
                  icon={<Check size={15} strokeWidth={2.4} />}
                  primary
                  onClick={() => void done()}
                />
              </>
            ) : (
              <>
                <IconBtn
                  tip={t('aboutFull.edit')}
                  icon={<Pencil size={15} strokeWidth={2} />}
                  onClick={enterEdit}
                />
                <IconBtn
                  tip={t('aboutFull.history')}
                  icon={<History size={15} strokeWidth={2} />}
                  onClick={() => setHistOpen((v) => !v)}
                />
                <IconBtn
                  tip={t('aboutFull.close')}
                  icon={<X size={15} strokeWidth={2} />}
                  onClick={handleClose}
                />
              </>
            )}

            {/* 历史小气泡：从 ⏱ 下方弹出（top-full），右对齐工具条——仅只读态 */}
            {histOpen && !editing && (
              <ProfileHistoryPopover
                relPath={relPath}
                onClose={() => setHistOpen(false)}
                onRestore={async (id) => {
                  await useEditorStore.getState().restoreFromHistory(key, id);
                }}
              />
            )}
          </div>
        </div>

        {/* 可滚动主体：标题 + 正文 + 脚注 */}
        <div className="px-[42px] pb-[26px]">
          {/* 标题（衬线） */}
          <div className="font-serif text-[23px] font-semibold tracking-[-0.01em] text-text-primary">
            {title}
          </div>

          {/* 正文区域——读/写同一个 MdEditor（readOnly 切换），同一 livePreview 渲染器，
              进出编辑零跳变（demo / Oru 内部编辑器同款：唯一变化是光标行露 md 语法）。 */}
          <div className="mt-5">
            <MdEditor
              value={content}
              onChange={(v) => useEditorStore.getState().setContent(key, v)}
              onSave={editing ? () => void done() : undefined}
              readOnly={!editing}
              docIdentity={null}
              themeExtension={profileEditorTheme}
              highlightStyle={profileHighlight}
            />
          </div>

          {/* 脚注插槽 */}
          {footer && <div className="mt-[26px] border-t border-border pt-3.5">{footer}</div>}
        </div>
      </div>
    </Overlay>
  );
}
