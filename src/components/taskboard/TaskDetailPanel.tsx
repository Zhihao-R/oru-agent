/**
 * 任务详情侧栏（替代 TaskDetailModal）。
 *
 * 加载：挂载时 wsClient.request taskboard.get → 拿完整 BoardTask（含 description）。
 *   list 返回的是 BoardTaskMeta（去掉了 description），所以详情必须单独 get。
 *
 * 字段编辑全部 inline：
 *   - 标题：默认大衬线纯文字，点击 → contentEditable-style input；blur/Enter 保存，Esc 撤销
 *   - 状态：顶部 chip，点击弹 StatusMenu
 *   - 描述：默认渲染为正文（空态显示灰字"添加描述…"），点击 → textarea；⌘Enter 保存
 *   - 归属：popover 选 you/oru
 *   - 项目：popover 输入 + datalist 历史候选
 *
 * 删除：塞进 ⋯ 菜单，无主区按钮。二次确认仍走 Dialog。
 *
 * 外部并发：本面板打开期间任务被 Oru 改动 → broadcast taskUpsert 进 list store；
 *   meta 字段（标题/归属/tag/状态）实时反映；description 不在 meta 里，故 DetailBody 监听
 *   liveMeta.updatedAt 前移后重取完整 task 刷新描述（用户正在编辑时不覆盖）。
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toastError } from '@/lib/toast';
import { Paperclip, Trash2, X } from 'lucide-react';
import type { BoardActorId, BoardTask, BoardTaskStatus, ChatAttachment } from '@shared/types';
import type { WireImageAttachment } from '@shared/protocol';
import { DeleteConfirm as SharedDeleteConfirm } from '@/components/ui/DeleteConfirm';
import { AttachmentGallery } from '@/components/ui/AttachmentGallery';
import { IconButton } from '@/components/ui/IconButton';
import { useImagePicker } from '@/components/ui/useImagePicker';
import {
  IMAGE_ACCEPT,
  buildPendingAttachments,
  checkCountLimit,
  toWireAttachments,
} from '@/lib/imageAttachments';
import { wsClient } from '@/lib/ws';
import { selectTagSuggestions, useTaskboardStore } from '@/stores/taskboardStore';
import { cn } from '@/lib/cn';
import { DescriptionEditor } from './DescriptionEditor';
import { StatusBadge } from './StatusBadge';
import { StatusMenu } from './StatusMenu';
import { statusLabel } from './statusLabel';
import { CommentThread } from './CommentThread';

const ASSIGNEE_VALUES: BoardActorId[] = ['you', 'oru'];

export type TaskDetailPanelProps = {
  taskId: string;
  onClose: () => void;
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; task: BoardTask }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

export function TaskDetailPanel({ taskId, onClose }: TaskDetailPanelProps) {
  const { t } = useTranslation('taskboard');
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });
    wsClient
      .request({ type: 'taskboard.get', id: taskId })
      .then((res) => {
        if (cancelled) return;
        if (res.type !== 'taskboard.get.result') {
          // 不在 effect 内调 t()——否则 t 进依赖、切语言会重新 fetch。空 message 由渲染层兜成通用文案。
          setLoad({ kind: 'error', message: '' });
          return;
        }
        if (res.task == null) {
          setLoad({ kind: 'not-found' });
          return;
        }
        setLoad({ kind: 'loaded', task: res.task });
      })
      .catch((err: Error) => {
        if (!cancelled) setLoad({ kind: 'error', message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // overflow-hidden + 不用 h-full：作为 grid 项，h-full(=height:100%) 相对 auto 行算成 auto，
  // 会被内容撑高、内部 overflow-y-auto 永不触发。镜像同文件 main 的 flex-col+overflow-hidden 收口
  // （min-content 高为 0，不撑 grid 行），内部滚动区才生效（一期文档 §六）。
  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-border bg-elevated">
      <Toolbar onClose={onClose} taskId={taskId} task={load.kind === 'loaded' ? load.task : null} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {load.kind === 'loading' ? (
          <div className="px-7 py-12 text-center text-sm text-text-tertiary">{t('common:loading')}</div>
        ) : load.kind === 'not-found' ? (
          <div className="px-7 py-12 text-center text-sm text-text-tertiary">
            {t('detail.notFound')}
          </div>
        ) : load.kind === 'error' ? (
          <div className="px-7 py-12 text-center text-sm text-danger">
            {t('detail.loadFailedMsg', { message: load.message || t('detail.loadFailed') })}
          </div>
        ) : (
          <DetailBody task={load.task} />
        )}
      </div>
    </aside>
  );
}

// ─── Toolbar (顶部图标：删除 + 关闭) ───────────────────────────────────

function Toolbar({
  onClose,
  taskId,
  task,
}: {
  onClose: () => void;
  taskId: string;
  task: BoardTask | null;
}) {
  const { t } = useTranslation('taskboard');
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <>
      <div className="flex items-center justify-end gap-1 px-3 pt-3">
        <button
          type="button"
          title={t('detail.toTrash')}
          aria-label={t('detail.toTrash')}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-text-secondary transition-colors hover:bg-hover hover:text-danger disabled:opacity-50"
          onClick={() => setConfirmDelete(true)}
          disabled={!task}
        >
          <Trash2 size={14} strokeWidth={1.6} />
        </button>
        <button
          type="button"
          title={t('detail.close')}
          aria-label={t('common:close')}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          onClick={onClose}
        >
          <X size={14} strokeWidth={1.6} />
        </button>
      </div>
      {confirmDelete && task ? (
        <DeleteConfirm
          taskId={taskId}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </>
  );
}

function DeleteConfirm({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { t } = useTranslation('taskboard');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    setDeleting(true);
    setError(null);
    try {
      await wsClient.request({ type: 'taskboard.delete', id: taskId });
      // store.applyDelete 会自动把 selectedTaskId=null，面板自动关
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <SharedDeleteConfirm
      open
      description={t('detail.deleteConfirm')}
      deleting={deleting}
      error={error}
      onConfirm={() => void onConfirm()}
      onClose={onClose}
    />
  );
}

// ─── Body ──────────────────────────────────────────────────────────────

function DetailBody({ task: initialTask }: { task: BoardTask }) {
  const { t } = useTranslation('taskboard');
  // description 只在 meta 之外的完整 task 里；远程（Oru）改描述后 list store 的 meta
  // updatedAt 会前移，但描述不在 meta 里——据此重取完整 task 刷新描述。
  // 用户正在编辑时不会被覆盖：DescriptionField 仅在非编辑态从 initial 同步。
  const [task, setTask] = useState(initialTask);
  const liveMeta = useTaskboardStore((s) => s.tasks.find((x) => x.id === task.id));
  const tasks = useTaskboardStore((s) => s.tasks);
  const tagSuggestions = useMemo(() => selectTagSuggestions({ tasks }), [tasks]);

  const loadedUpdatedAt = task.updatedAt;
  useEffect(() => {
    if (!liveMeta || liveMeta.updatedAt <= loadedUpdatedAt) return;
    let cancelled = false;
    wsClient
      .request({ type: 'taskboard.get', id: task.id })
      .then((res) => {
        if (cancelled) return;
        if (res.type === 'taskboard.get.result' && res.task) setTask(res.task);
      })
      .catch(() => {
        // 刷新失败不阻断——面板继续显示已加载版本
      });
    return () => {
      cancelled = true;
    };
  }, [liveMeta?.updatedAt, loadedUpdatedAt, task.id]);

  const commit = async <K extends 'title' | 'description' | 'status' | 'assignee' | 'projectTag'>(
    field: K,
    value: BoardTask[K] | undefined,
  ) => {
    try {
      await wsClient.request({
        type: 'taskboard.update',
        id: task.id,
        patch: { [field]: value } as { [P in K]?: BoardTask[P] },
      });
    } catch (err) {
      console.warn(`[taskboard] 更新 ${field} 失败:`, err);
      toastError(t('toast.updateFailed'));
    }
  };

  const status = liveMeta?.status ?? task.status;
  const assignee = liveMeta?.assignee ?? task.assignee;
  const projectTag = liveMeta?.projectTag ?? task.projectTag;
  const title = liveMeta?.title ?? task.title;

  // ── 描述图片（选/粘/拖三路共用一个落点）──
  // picker 收口在 Body 层：粘贴发生在描述编辑框、选与拖在图片区，两处共用同一 onAddFiles，
  // 即时上传 setAttachments、用回执 task 刷新面板。
  const attachments = task.attachments ?? [];
  // 增量语义：只传 add / removeRelPaths，后端锁内基于最新盘合成——不传「全集」避免快照过期覆盖丢图
  const persistAttachments = async (add: WireImageAttachment[], removeRelPaths: string[]) => {
    const res = await wsClient.request({
      type: 'taskboard.setAttachments',
      taskId: task.id,
      add,
      removeRelPaths,
    });
    if (res.type === 'taskboard.setAttachments.result') setTask(res.task);
  };
  // 客户端先校验格式 / 大小 / 总数（复用评论那套，best-effort），过了转 wire 即时上传
  const onAddImageFiles = (files: File[]): string | null => {
    const { accepted, reason } = buildPendingAttachments(files);
    if (reason) return reason;
    const over = checkCountLimit(attachments.length, accepted);
    if (over) return over;
    void (async () => {
      const add = await toWireAttachments(accepted);
      accepted.forEach((a) => URL.revokeObjectURL(a.displayUrl)); // 临时预览 blob，用完即弃
      try {
        await persistAttachments(add, []);
      } catch (e) {
        console.warn('[taskboard] setAttachments 添加失败:', e);
        toastError(t('toast.updateFailed'));
      }
    })();
    return null;
  };
  const imagePicker = useImagePicker(onAddImageFiles);
  const onRemoveAttachment = (a: ChatAttachment) => {
    void (async () => {
      try {
        await persistAttachments([], [a.relPath]);
      } catch (e) {
        console.warn('[taskboard] setAttachments 移除失败:', e);
        toastError(t('toast.updateFailed'));
      }
    })();
  };

  return (
    <div className="px-7 pb-6 pt-3">
      <TitleField initial={title} onCommit={(v) => void commit('title', v)} />
      <DescriptionField
        initial={task.description ?? ''}
        onCommit={(v) => void commit('description', v.trim() || undefined)}
        onPaste={imagePicker.onPaste}
      />
      <DescriptionAttachments attachments={attachments} picker={imagePicker} onRemove={onRemoveAttachment} />

      <PropsBlock>
        <PropRow label={t('detail.propStatus')}>
          <StatusField value={status} taskId={task.id} />
        </PropRow>
        <PropRow label={t('detail.propAssignee')}>
          <AssigneeField
            value={assignee}
            onChange={(next) => void commit('assignee', next)}
          />
        </PropRow>
        <PropRow label={t('detail.propProject')}>
          <ProjectTagField
            value={projectTag ?? ''}
            suggestions={tagSuggestions}
            onCommit={(v) => void commit('projectTag', v.trim() || undefined)}
          />
        </PropRow>
        <PropRow label={t('detail.propCreated')}>
          <span className="px-1.5 py-1 text-xs tabular-nums text-text-secondary">
            {formatTs(task.createdAt, t)}
          </span>
        </PropRow>
        <PropRow label={t('detail.propUpdated')}>
          <span className="px-1.5 py-1 text-xs tabular-nums text-text-secondary">
            {formatTs(task.updatedAt, t)}
          </span>
        </PropRow>
      </PropsBlock>

      <div className="my-5 h-px bg-border" />

      {/* 评论线 */}
      <CommentThread taskId={task.id} />
    </div>
  );
}

function formatTs(ts: number, t: TFunction): string {
  const d = new Date(ts);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return t('detail.dateFormat', { month: d.getMonth() + 1, day: d.getDate(), time });
}

// ─── Status field (作为 PropRow 的值，与 AssigneeField 同款风格) ────────

/**
 * StatusMenu 自己直接 wsClient.update + broadcast 同步，所以这里
 * 不需要 onChange 回调走 commit 路径——store 收到 broadcast 自动更新 liveMeta。
 */
function StatusField({
  value,
  taskId,
}: {
  value: BoardTaskStatus;
  taskId: string;
}) {
  const { t } = useTranslation('taskboard');
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          '-mx-1.5 inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-sm text-text-primary transition-colors hover:bg-hover',
          open && 'bg-hover',
        )}
      >
        <StatusBadge status={value} size={13} />
        <span>{statusLabel(value, t)}</span>
      </button>
      {open ? (
        <StatusMenu
          taskId={taskId}
          currentStatus={value}
          anchorRef={ref}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

// ─── Title field (inline editable) ─────────────────────────────────────

function TitleField({ initial, onCommit }: { initial: string; onCommit: (v: string) => void }) {
  const { t } = useTranslation('taskboard');
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setV(initial);
  }, [initial, editing]);

  useLayoutEffect(() => {
    if (editing) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [editing]);

  const save = () => {
    setEditing(false);
    const trimmed = v.trim();
    if (trimmed && trimmed !== initial) onCommit(trimmed);
    else setV(initial);
  };

  // unmount 时自动保存（用户编辑标题中切 sidebar 分组、关面板等场景，
  // React 不触发 onBlur，否则编辑内容会丢）
  useUnmountSave(editing, v, initial, onCommit, { trim: true });

  if (editing) {
    return (
      <input
        ref={ref}
        type="text"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // 输入法选词态回车不提交
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          }
          if (e.key === 'Escape') {
            setV(initial);
            setEditing(false);
          }
        }}
        className="-mx-1.5 mb-4 block w-[calc(100%+0.75rem)] rounded-md border border-accent bg-elevated px-1.5 py-0.5 font-serif text-2xl tracking-tight text-text-primary outline-none ring-2 ring-accent-ring"
      />
    );
  }

  return (
    <h1
      className="-mx-1.5 mb-4 cursor-text rounded-md px-1.5 py-0.5 font-serif text-2xl tracking-tight text-text-primary transition-colors hover:bg-hover"
      onClick={() => setEditing(true)}
      title={t('detail.editHint')}
    >
      {initial}
    </h1>
  );
}

// ─── Description field (inline editable, empty-state placeholder) ──────

function DescriptionField({
  initial,
  onCommit,
  onPaste,
}: {
  initial: string;
  onCommit: (v: string) => void;
  /** 编辑框内粘贴图片 → 交给描述图片落点（与新建对话框同款接线） */
  onPaste?: React.ClipboardEventHandler;
}) {
  const { t } = useTranslation('taskboard');
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setV(initial);
  }, [initial, editing]);

  useLayoutEffect(() => {
    if (editing) {
      const el = ref.current;
      if (!el) return;
      el.focus();
      // 光标置末尾
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
  }, [editing]);

  const save = () => {
    setEditing(false);
    if (v !== initial) onCommit(v);
  };

  // unmount 时自动保存
  useUnmountSave(editing, v, initial, onCommit, { trim: false });

  if (editing) {
    return (
      <div className="mb-5">
        <DescriptionEditor
          ref={ref}
          value={v}
          onChange={setV}
          onCommit={save}
          onCancel={() => {
            setV(initial);
            setEditing(false);
          }}
          onBlur={save}
          onPaste={onPaste}
          rows={4}
          placeholder={t('detail.descPlaceholder')}
          hint={t('detail.descSaveHint')}
          className="border border-accent bg-elevated ring-2 ring-accent-ring"
        />
      </div>
    );
  }

  if (!initial) {
    return (
      <p
        className="mb-5 cursor-text py-1 text-sm text-text-tertiary transition-colors hover:text-text-secondary"
        onClick={() => setEditing(true)}
      >
        {t('detail.addDesc')}
      </p>
    );
  }

  return (
    <div
      className="-mx-1.5 mb-5 cursor-text whitespace-pre-wrap rounded-md px-1.5 py-1 text-sm leading-6 text-text-primary transition-colors hover:bg-hover"
      onClick={() => setEditing(true)}
      title={t('detail.editHint')}
    >
      {initial}
    </div>
  );
}

// ─── Description image attachments (view + add + remove, 即时) ──────────
//
// 详情面板任务已有 id，图片即时增删：选/粘/拖 → 上传 → setAttachments → 用回执 task 更新面板。
// 与新建对话框「暂存到保存」不同（那边任务还没 id）——落点不同、UX 同（图在描述下方、点击应用内看大图）。
// picker 与落点逻辑在 DetailBody（粘贴要接到描述编辑框），本组件纯呈现。

function DescriptionAttachments({
  attachments,
  picker,
  onRemove,
}: {
  attachments: ChatAttachment[];
  picker: ReturnType<typeof useImagePicker>;
  onRemove: (a: ChatAttachment) => void;
}) {
  const { t } = useTranslation('taskboard');

  return (
    <div
      {...picker.dragHandlers}
      className={cn('mb-5 rounded-md', picker.isDragOver && 'ring-2 ring-accent-ring')}
    >
      <AttachmentGallery attachments={attachments} align="start" onRemove={onRemove} />
      <div className={attachments.length > 0 ? 'mt-1.5' : ''}>
        <input
          ref={picker.fileInputRef}
          type="file"
          multiple
          accept={IMAGE_ACCEPT}
          hidden
          onChange={(e) => {
            picker.onPickFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={picker.openPicker}
          className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary"
        >
          <Paperclip size={13} strokeWidth={1.7} />
          {t('detail.addImage')}
        </button>
      </div>
    </div>
  );
}

// ─── Properties block ───────────────────────────────────────────────────

function PropsBlock({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-0.5">{children}</div>;
}

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-[32px] grid-cols-[60px_1fr] items-center gap-3">
      <span className="text-xs text-text-tertiary">{label}</span>
      <div>{children}</div>
    </div>
  );
}

// ─── Assignee field ────────────────────────────────────────────────────

function AssigneeField({
  value,
  onChange,
}: {
  value: BoardActorId;
  onChange: (next: BoardActorId) => void;
}) {
  const { t } = useTranslation('taskboard');
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = t(`assignee.${value}`, { defaultValue: value });
  const dotClass = value === 'you' ? 'bg-text-tertiary/60' : 'bg-accent';
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="-mx-1.5 inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-sm text-text-primary transition-colors hover:bg-hover"
      >
        <span className={cn('inline-block h-1.5 w-1.5 rounded-full', dotClass)} />
        <span>{label}</span>
      </button>
      {open ? (
        <Popover anchorRef={ref} onClose={() => setOpen(false)} width={140}>
          {ASSIGNEE_VALUES.map((optValue) => (
            <button
              key={optValue}
              type="button"
              onClick={() => {
                setOpen(false);
                if (optValue !== value) onChange(optValue);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-hover',
                optValue === value && 'bg-hover/60',
              )}
            >
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full',
                  optValue === 'you' ? 'bg-text-tertiary/60' : 'bg-accent',
                )}
              />
              <span className="text-text-primary">{t(`assignee.${optValue}`, { defaultValue: optValue })}</span>
            </button>
          ))}
        </Popover>
      ) : null}
    </>
  );
}

// ─── Project tag field (combobox: input + suggestions) ─────────────────

function ProjectTagField({
  value,
  suggestions,
  onCommit,
}: {
  value: string;
  suggestions: string[];
  onCommit: (v: string) => void;
}) {
  const { t } = useTranslation('taskboard');
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  const datalistId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setV(value);
  }, [value, editing]);

  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const save = () => {
    setEditing(false);
    if (v !== value) onCommit(v);
  };

  // unmount 时自动保存
  useUnmountSave(editing, v, value, onCommit, { trim: false });

  if (editing) {
    return (
      <>
        <input
          ref={inputRef}
          type="text"
          value={v}
          list={datalistId}
          onChange={(e) => setV(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // 输入法选词态回车不提交
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            }
            if (e.key === 'Escape') {
              setV(value);
              setEditing(false);
            }
          }}
          placeholder={t('newTask.projectPlaceholder')}
          className="-mx-1.5 inline-block min-w-[120px] rounded-md border border-accent bg-elevated px-1.5 py-0.5 text-sm text-text-primary outline-none ring-2 ring-accent-ring"
        />
        <datalist id={datalistId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </>
    );
  }

  if (!value) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="-mx-1.5 rounded px-1.5 py-1 text-xs text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary"
      >
        {t('detail.addProject')}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="-mx-1.5 inline-flex items-center gap-0.5 rounded px-1.5 py-1 text-sm text-text-primary transition-colors hover:bg-hover"
    >
      <span className="text-text-tertiary/70">#</span>
      <span>{value}</span>
    </button>
  );
}

// ─── unmount 自动保存 hook ──────────────────────────────────────────────
//
// 解决：用户在 inline 编辑（标题/描述/项目）时切 sidebar 分组、关面板等场景，
// React unmount 不会触发 onBlur，编辑内容会丢失。
// 用 ref 持最新 v / initial / onCommit，cleanup 里 commit。

function useUnmountSave(
  editing: boolean,
  v: string,
  initial: string,
  onCommit: (v: string) => void,
  opts: { trim: boolean },
) {
  const ref = useRef({ editing, v, initial, onCommit, trim: opts.trim });
  ref.current = { editing, v, initial, onCommit, trim: opts.trim };
  // Strict Mode 守卫：开发环境会 mount → cleanup → mount 双跑，
  // 第一次 cleanup 是 React 的"假卸载"，didMount 一直是 true 但下一次 mount
  // 又会把它设 true，看似无差别——关键是 cleanup 里 ref 的 editing 字段在
  // strict mode 假 mount 时一定是 false（用户没机会交互），所以现有的
  // `if (!editing) return` 已经能安全跳过假 cleanup。这里仅文档化、
  // 不再加额外 ref 守卫——避免逻辑越绕越脆。
  useEffect(() => {
    return () => {
      const { editing, v, initial, onCommit, trim } = ref.current;
      if (!editing) return;
      const value = trim ? v.trim() : v;
      if (trim && !value) return; // 标题清空忽略
      if (value === initial) return;
      onCommit(value);
    };
  }, []);
}

// ─── Reusable popover (anchored, click-outside / escape closes) ────────

function Popover({
  anchorRef,
  align = 'left',
  width = 160,
  onClose,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  align?: 'left' | 'right';
  width?: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 两阶段定位：
  //  第一帧 ref.current === null → 用 fallback 200 估高度算粗略位置（先 render 出来量真实尺寸）
  //  第二帧（rAF）ref 已挂 → 用真实 offsetHeight 再 clamp 一次
  // 视觉上第一帧是 visibility:hidden（见 render），用户看不到错位。
  useLayoutEffect(() => {
    const compute = () => {
      const a = anchorRef.current;
      if (!a) return;
      const r = a.getBoundingClientRect();
      const estHeight = ref.current?.offsetHeight ?? 200;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top = r.bottom + 4;
      let left = align === 'right' ? r.right - width : r.left;
      if (top + estHeight > vh - 8) top = Math.max(8, r.top - estHeight - 4);
      if (left + width > vw - 8) left = Math.max(8, vw - width - 8);
      if (left < 8) left = 8;
      setPos({ top, left });
    };
    compute();
    // 第二帧再量一次真实高度
    const raf = requestAnimationFrame(compute);
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [anchorRef, align, width]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 阻止冒泡到 TaskboardMainView 的全局 Esc——关 popover 不应该把详情面板也关掉
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  // pos === null 时仍然渲染（visibility:hidden）—— 让 ref.offsetHeight 在第一帧能被量到，
  // 第二帧 rAF 重 compute 后用真实高度做 clamp。否则首帧 fallback=200 会让靠近视口底部的
  // 弹出位置估算错误（实际菜单可能仅 80px 但按 200 翻转 → 不必要地翻到上方）。
  return (
    <div
      ref={ref}
      role="menu"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="fixed z-50 overflow-hidden rounded-md border border-border bg-elevated p-1 shadow-pop"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}
