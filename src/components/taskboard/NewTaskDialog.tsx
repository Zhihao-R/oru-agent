/**
 * 新建任务对话框：标题 autoFocus + 回车保存（仅标题必填）。
 *
 * 字段：
 *   - 标题（必填）
 *   - 描述（可选，textarea）
 *   - 归属（默认"你"）
 *   - 项目 tag（输入框 + datalist 历史候选）
 *
 * 保存：wsClient.request taskboard.create；广播 taskUpsert 回来后 store 自动 push。
 * 关闭：onClose；open=false 重置内部 state。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Paperclip } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { DeleteConfirm } from '@/components/ui/DeleteConfirm';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Select } from '@/components/ui/Select';
import { AttachmentStrip } from '@/components/ui/AttachmentStrip';
import { useImagePicker } from '@/components/ui/useImagePicker';
import { usePendingImages } from '@/components/ui/usePendingImages';
import { IMAGE_ACCEPT, toWireAttachments } from '@/lib/imageAttachments';
import { cn } from '@/lib/cn';
import { wsClient } from '@/lib/ws';
import { selectTagSuggestions, useTaskboardStore } from '@/stores/taskboardStore';
import { DescriptionEditor } from './DescriptionEditor';

export type NewTaskDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function NewTaskDialog({ open, onClose }: NewTaskDialogProps) {
  const { t } = useTranslation('taskboard');
  const assigneeOptions = [
    { value: 'you', label: t('assignee.you') },
    { value: 'oru', label: t('assignee.oru') },
  ];
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState<'you' | 'oru'>('you');
  const [projectTag, setProjectTag] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 草稿保护：写了描述 / 加了图再关（取消 / Esc / 遮罩 / X）先二次确认，避免误触丢草稿
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // 描述图片：任务还没 id，先在渲染端以 blob 暂存，保存时随 create 落盘；取消即丢弃（无孤儿任务）
  const images = usePendingImages();
  const picker = useImagePicker(images.add);
  const titleRef = useRef<HTMLInputElement>(null);
  const datalistId = useId();
  // selectTagSuggestions 返回新数组：直接当 zustand selector 会触发无限重渲染
  const tasks = useTaskboardStore((s) => s.tasks);
  const sidebarGroup = useTaskboardStore((s) => s.sidebarGroup);
  const tagSuggestions = useMemo(() => selectTagSuggestions({ tasks }), [tasks]);

  // open=false 时重置；open=true 时按当前 sidebar 分组预填默认值——
  // 比如用户在 "Oru 的" 分组建任务，默认归属 oru；在 "# core" 分组建，默认 tag=core。
  // 否则建出来的任务可能不在当前列表里，让人困惑"建到哪去了"。
  useEffect(() => {
    if (!open) {
      setTitle('');
      setDescription('');
      setAssignee('you');
      setProjectTag('');
      setError(null);
      setSubmitting(false);
      setConfirmDiscard(false);
      images.clear(); // revoke 暂存 blob（取消 / 关闭 / 提交后统一在此清）
      return;
    }
    // open 时按当前 group 预填
    if (sidebarGroup.kind === 'oru') setAssignee('oru');
    else if (sidebarGroup.kind === 'mine') setAssignee('you');
    if (sidebarGroup.kind === 'tag') setProjectTag(sidebarGroup.tag);
    // 等 Dialog 动画结束 + DOM 挂上再 focus
    const timer = setTimeout(() => titleRef.current?.focus(), 50);
    return () => clearTimeout(timer);
    // sidebarGroup 不进依赖：只在 open 翻转时取一次快照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trimmedTitle = title.trim();
  const canSave = trimmedTitle.length > 0 && !submitting;

  // 关闭请求：描述非空且非提交中 → 先弹二次确认（草稿保护），否则直接关。
  // 拦住 Dialog 的 Esc / 遮罩 / X 与底部"取消"三条路径。
  const requestClose = () => {
    if (!submitting && (description.trim().length > 0 || images.items.length > 0)) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  const submit = async () => {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    try {
      const attachments = images.items.length > 0 ? await toWireAttachments(images.items) : undefined;
      await wsClient.request({
        type: 'taskboard.create',
        title: trimmedTitle,
        description: description.trim() || undefined,
        assignee,
        projectTag: projectTag.trim() || undefined,
        attachments,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
    <Dialog
      open={open}
      onClose={requestClose}
      title={t('sidebar.newTask')}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={requestClose} disabled={submitting}>
            {t('common:cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void submit()}
            disabled={!canSave}
          >
            {submitting ? t('common:saving') : t('newTask.saveEnter')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className="text-xs font-medium text-text-secondary">{t('newTask.title')}</span>
          <Input
            ref={titleRef}
            className="mt-1.5"
            placeholder={t('newTask.titlePlaceholder')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return; // 输入法选词态回车不提交
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            disabled={submitting}
            invalid={Boolean(error)}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-text-secondary">{t('newTask.desc')}</span>
          <div
            {...picker.dragHandlers}
            className={cn('mt-1.5 rounded-md', picker.isDragOver && 'ring-2 ring-accent-ring')}
          >
            <DescriptionEditor
              value={description}
              onChange={setDescription}
              onCommit={() => void submit()}
              onPaste={picker.onPaste}
              rows={3}
              placeholder={t('newTask.descPlaceholder')}
              disabled={submitting}
              className="border border-border bg-elevated focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring"
            />
            <div className="mt-1.5 flex flex-col gap-1.5">
              <AttachmentStrip items={images.items} onRemove={images.remove} />
              <div>
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
                <IconButton
                  size="sm"
                  label={t('comment.attach')}
                  disabled={submitting}
                  onClick={picker.openPicker}
                >
                  <Paperclip size={14} strokeWidth={1.8} />
                </IconButton>
              </div>
            </div>
          </div>
        </label>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="text-xs font-medium text-text-secondary">{t('newTask.assignee')}</span>
            <Select
              size="sm"
              options={assigneeOptions}
              value={assignee}
              onChange={(e) => setAssignee(e.target.value as 'you' | 'oru')}
              disabled={submitting}
            />
          </label>
          <label className="flex flex-1 items-center gap-2">
            <span className="text-xs font-medium text-text-secondary">{t('newTask.project')}</span>
            {/*
              不在此 Input 上绑 Enter→submit：
              datalist 候选项用 Enter 选中也会触发 keydown Enter，会把表单提交得太早。
              用户走标题 Input 上的 Enter 或点底部"保存"按钮即可。
            */}
            <Input
              list={datalistId}
              placeholder={t('newTask.projectPlaceholder')}
              value={projectTag}
              onChange={(e) => setProjectTag(e.target.value)}
              disabled={submitting}
            />
            <datalist id={datalistId}>
              {tagSuggestions.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
          </label>
        </div>
        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    </Dialog>
    <DeleteConfirm
      open={confirmDiscard}
      title={t('newTask.discardTitle')}
      description={t('newTask.discardBody')}
      confirmLabel={t('newTask.discardConfirm')}
      onConfirm={() => {
        setConfirmDiscard(false);
        onClose();
      }}
      onClose={() => setConfirmDiscard(false)}
    />
    </>
  );
}
