/**
 * 浮层抽屉——按 selected event 渲染详情子组件。
 *
 * 设计：
 * - 浮在时间线右侧上方（absolute，不挤占时间线宽度）
 * - 半透明背景遮罩，点击关闭
 * - 左沿 6px 拖拽热区，中央 2px 视觉条 hover 变 accent；宽度 360–720 持久化 localStorage
 * - selected = null 时整体 hidden（不卸载子树，保留滚动位置）
 *
 * 拖拽实现：document 上挂 mousemove / mouseup，onUp 里恢复 cursor / userSelect 并 removeEventListener。
 * 这样组件在拖拽中被卸载时，最后 mouseup 仍会触发 onUp，全局样式不会残留——
 * 跟项目已有的 ResizeHandle 同模式。
 *
 * 详 docs/prd/2026-05-10-debug-redesign-prd.md §2.3。
 */
import { useRef, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  X,
  User,
  FileText,
  Brain,
  MessageCircle,
  AlertCircle,
  CheckCircle2,
  Wrench,
  Eye,
  type LucideIcon,
} from 'lucide-react';

import type { DebugEventType, DebugRecord } from '@shared/debug/types';
import type { SelectedEvent } from '@/stores/debugStore';
import { RoundStartDetail } from './details/RoundStartDetail';
import { LlmCallDetail } from './details/LlmCallDetail';
import { ToolCallDetail, ToolCallUnfinishedDetail } from './details/ToolCallDetail';
import { FinalAnswerDetail } from './details/FinalAnswerDetail';
import { ErrorDetail } from './details/ErrorDetail';
import { GenericDetail } from './details/GenericDetail';
import { PromptBuiltDetail } from './details/PromptBuiltDetail';
import { InferenceViewDetail } from './details/InferenceViewDetail';

const WIDTH_MIN = 360;
const WIDTH_MAX = 720;
const WIDTH_DEFAULT = 480;
const STORAGE_KEY = 'oru-debug-drawer-width';

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function readSavedWidth(): number {
  if (typeof window === 'undefined') return WIDTH_DEFAULT;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return WIDTH_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return WIDTH_DEFAULT;
  return clamp(n, WIDTH_MIN, WIDTH_MAX);
}

export function DebugDrawer({
  selected,
  onClose,
}: {
  selected: SelectedEvent | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('debug');
  const visible = selected !== null;
  const [width, setWidth] = useState<number>(readSavedWidth);
  const onChangeRef = useRef(setWidth);
  onChangeRef.current = setWidth;

  function onGripDown(e: MouseEvent<HTMLDivElement>): void {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    let pending = startWidth;
    let frame = 0;
    function flush(): void {
      frame = 0;
      onChangeRef.current(pending);
    }
    function onMove(ev: globalThis.MouseEvent): void {
      // grip 在抽屉左沿；鼠标向左拖（dx 为负）→ 抽屉变宽
      const dx = ev.clientX - startX;
      pending = clamp(startWidth - dx, WIDTH_MIN, WIDTH_MAX);
      if (frame === 0) frame = requestAnimationFrame(flush);
    }
    function onUp(): void {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
        onChangeRef.current(pending);
      }
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // 持久化最终宽度
      window.localStorage.setItem(STORAGE_KEY, String(Math.round(pending)));
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  return (
    <>
      {/* 半透明背景遮罩——点击关闭。selected = null 时不可见也不可点。 */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`pointer-events-none absolute inset-0 z-10 bg-black/[0.04] transition-opacity duration-150 ${
          visible ? 'opacity-100 pointer-events-auto' : 'opacity-0'
        }`}
      />

      {/* 浮层抽屉 */}
      <aside
        style={{ width: `${width}px` }}
        className={`absolute right-0 top-0 z-20 flex h-full flex-col border-l border-border bg-elevated shadow-pop transition-transform duration-200 ${
          visible ? 'translate-x-0' : 'pointer-events-none translate-x-full'
        }`}
      >
        {/* 拖拽 grip：6px 宽热区，中央 2px 视觉条 hover 变 accent */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('drawer.resize')}
          onMouseDown={onGripDown}
          className="group absolute -left-[3px] top-0 h-full w-[6px] cursor-ew-resize"
        >
          <span className="pointer-events-none absolute left-[2px] top-1/2 h-8 w-[2px] -translate-y-1/2 rounded-full bg-border transition-colors group-hover:bg-accent" />
        </div>

        {selected ? (
          <>
            <DrawerHeader record={selected.record} onClose={onClose} />
            <div className="flex-1 select-text overflow-y-auto p-4">{renderBody(selected)}</div>
          </>
        ) : null}
      </aside>
    </>
  );
}

/** 标题行——用与 EventRow 同一套 lucide 图标系统，保持视觉延续 */
function DrawerHeader({ record, onClose }: { record: DebugRecord; onClose: () => void }) {
  const { t } = useTranslation('debug');
  const { Icon, label, iconClass } = headerFor(record.type, record, t);
  return (
    <header className="flex items-center justify-between border-b border-border px-3 py-2">
      <h3 className="flex min-w-0 items-center gap-2 font-medium text-text-primary">
        <Icon size={14} strokeWidth={1.5} className={iconClass} />
        <span className="truncate">{label}</span>
      </h3>
      <button
        type="button"
        onClick={onClose}
        className="rounded p-1 text-text-tertiary transition-colors hover:bg-hover hover:text-text-primary"
        aria-label={t('common:close')}
      >
        <X size={14} strokeWidth={1.5} />
      </button>
    </header>
  );
}

interface HeaderSpec {
  Icon: LucideIcon;
  label: string;
  iconClass: string;
}

function headerFor(type: DebugEventType, record: DebugRecord, t: TFunction): HeaderSpec {
  switch (type) {
    case 'round_start':
      return { Icon: User, label: t('event.userInput'), iconClass: 'text-accent' };
    case 'prompt_built':
      return { Icon: FileText, label: t('event.promptBuilt'), iconClass: 'text-text-tertiary' };
    case 'inference_view':
      return { Icon: Eye, label: t('event.inferenceView'), iconClass: 'text-text-tertiary' };
    case 'llm_call_start':
      return { Icon: Brain, label: t('event.llmCallUnfinished'), iconClass: 'text-warn' };
    case 'llm_call_done': {
      const p = record.payload as { callIndex: number };
      return { Icon: Brain, label: t('event.llmCallN', { n: p.callIndex }), iconClass: 'text-accent' };
    }
    case 'parallel_group_start':
      return { Icon: CheckCircle2, label: t('event.parallelGroup'), iconClass: 'text-text-tertiary' };
    case 'parallel_group_done':
      return { Icon: CheckCircle2, label: t('event.parallelGroupDone'), iconClass: 'text-success' };
    case 'tool_call_start':
      return { Icon: Wrench, label: t('event.toolCallUnfinished'), iconClass: 'text-warn' };
    case 'tool_call_done':
      return { Icon: Wrench, label: t('event.toolCall'), iconClass: 'text-success' };
    case 'final_answer':
      return { Icon: MessageCircle, label: t('event.finalAnswer'), iconClass: 'text-accent' };
    case 'round_done':
      return { Icon: CheckCircle2, label: t('event.roundDone'), iconClass: 'text-success' };
    case 'error':
      return { Icon: AlertCircle, label: t('event.error'), iconClass: 'text-danger' };
    default:
      return { Icon: CheckCircle2, label: type, iconClass: 'text-text-tertiary' };
  }
}

function renderBody(selected: SelectedEvent): React.ReactNode {
  const { record, toolMeta } = selected;
  switch (record.type) {
    case 'round_start':
      return <RoundStartDetail record={record as DebugRecord<'round_start'>} />;
    case 'prompt_built':
      return <PromptBuiltDetail record={record as DebugRecord<'prompt_built'>} />;
    case 'inference_view':
      return <InferenceViewDetail record={record as DebugRecord<'inference_view'>} />;
    case 'llm_call_done':
      return <LlmCallDetail record={record as DebugRecord<'llm_call_done'>} />;
    case 'tool_call_done':
      return (
        <ToolCallDetail record={record as DebugRecord<'tool_call_done'>} toolMeta={toolMeta} />
      );
    case 'tool_call_start':
      return <ToolCallUnfinishedDetail record={record as DebugRecord<'tool_call_start'>} />;
    case 'final_answer':
      return <FinalAnswerDetail record={record as DebugRecord<'final_answer'>} />;
    case 'error':
      return <ErrorDetail record={record as DebugRecord<'error'>} />;
    default:
      return <GenericDetail record={record} />;
  }
}
