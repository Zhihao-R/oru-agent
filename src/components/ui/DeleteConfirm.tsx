/**
 * 通用删除二次确认 Dialog —— 任务板 / MCP 详情面板共用。
 *
 * 设计：
 * - 调用方负责 `onConfirm` 里发 RPC + 异常处理；本组件只管 UI 状态机
 * - `busyLabel` 控制按钮"删除中…"文案，未传则默认走 common:deleteConfirm.busyLabel
 * - `error` 由调用方传入，本组件不维护错误状态
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';
import { Button } from './Button';

export function DeleteConfirm({
  open,
  title,
  description,
  confirmLabel,
  busyLabel,
  deleting = false,
  error,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title?: string;
  description?: string;
  confirmLabel?: string;
  busyLabel?: string;
  deleting?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  // 默认文案在体内取词（默认值不能写中文字面，否则绕过 i18n）；调用方显式传入则优先
  const { t } = useTranslation('common');
  // 合成单个 body：无 error 且无 children 时传 undefined，避免 Dialog 收到 [null, null]
  // 数组当真、渲染出只剩内边距的空容器（弹窗标题与按钮行之间的空白即此）
  const body = error ? (
    <>
      <p className="text-xs text-danger">{error}</p>
      {children}
    </>
  ) : (
    children
  );
  return (
    <Dialog
      open={open}
      onClose={() => !deleting && onClose()}
      title={title ?? t('deleteConfirm.title')}
      description={description}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={deleting}>
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? (busyLabel ?? t('deleteConfirm.busyLabel')) : (confirmLabel ?? t('deleteConfirm.confirmLabel'))}
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}
