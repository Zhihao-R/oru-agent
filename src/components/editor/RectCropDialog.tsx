/**
 * 矩形裁剪对话框：拖框选区 + canvas 输出裁好的 PNG（破坏性 = 裁完写新图、引用纯 ![]() 可移植）。
 * 范式参考 AvatarCropDialog（拖动 + canvas 输出 PNG、不引三方库），但头像是圆形定尺寸，
 * 这里是矩形选框 + 按选区原分辨率输出——借范式不套组件（技术方案 §六）。
 *
 * oru-doc-img:// 图直接进 canvas 会 taint，故先 fetch 成 blob URL（协议支持 fetch）再裁，canvas 干净。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';

const MAX_DISPLAY = 460; // 预览区最长边
const MIN_SEL = 24; // 选区最小边（显示坐标）

type Rect = { x: number; y: number; w: number; h: number };
type Props = {
  url: string;
  onConfirm: (pngBlob: Blob) => void | Promise<void>;
  onCancel: () => void;
};

export function RectCropDialog({ url, onConfirm, onCancel }: Props): JSX.Element {
  const { t } = useTranslation('editor');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [disp, setDisp] = useState<{ w: number; h: number } | null>(null); // 显示尺寸
  const [sel, setSel] = useState<Rect | null>(null); // 选区（显示坐标）
  const imgRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ mode: 'move' | 'nw' | 'ne' | 'sw' | 'se'; sx: number; sy: number; orig: Rect } | null>(
    null,
  );

  // fetch 成 blob URL（避免 canvas taint）
  useEffect(() => {
    let revoked: string | null = null;
    let alive = true;
    void fetch(url)
      .then((r) => r.blob())
      .then((b) => {
        if (!alive) return;
        revoked = URL.createObjectURL(b);
        setBlobUrl(revoked);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [url]);

  const onImgLoad = (): void => {
    const im = imgRef.current;
    if (!im) return;
    const scale = Math.min(1, MAX_DISPLAY / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.round(im.naturalWidth * scale);
    const h = Math.round(im.naturalHeight * scale);
    setDisp({ w, h });
    // 初始选区 = 居中 80%
    setSel({ x: w * 0.1, y: h * 0.1, w: w * 0.8, h: h * 0.8 });
  };

  const clampSel = (r: Rect, d: { w: number; h: number }): Rect => {
    const w = Math.min(r.w, d.w);
    const h = Math.min(r.h, d.h);
    return {
      w,
      h,
      x: Math.max(0, Math.min(r.x, d.w - w)),
      y: Math.max(0, Math.min(r.y, d.h - h)),
    };
  };

  const startDrag = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!sel) return;
    drag.current = { mode, sx: e.clientX, sy: e.clientY, orig: { ...sel } };
  };

  useEffect(() => {
    if (!disp) return;
    const onMove = (e: MouseEvent): void => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      const o = d.orig;
      let next: Rect;
      if (d.mode === 'move') {
        next = { ...o, x: o.x + dx, y: o.y + dy };
      } else {
        // 角点缩放：固定对角，最小边约束
        let { x, y, w, h } = o;
        if (d.mode === 'nw') {
          x = o.x + dx;
          y = o.y + dy;
          w = o.w - dx;
          h = o.h - dy;
        } else if (d.mode === 'ne') {
          y = o.y + dy;
          w = o.w + dx;
          h = o.h - dy;
        } else if (d.mode === 'sw') {
          x = o.x + dx;
          w = o.w - dx;
          h = o.h + dy;
        } else {
          w = o.w + dx;
          h = o.h + dy;
        }
        if (w < MIN_SEL) {
          if (d.mode === 'nw' || d.mode === 'sw') x = o.x + o.w - MIN_SEL;
          w = MIN_SEL;
        }
        if (h < MIN_SEL) {
          if (d.mode === 'nw' || d.mode === 'ne') y = o.y + o.h - MIN_SEL;
          h = MIN_SEL;
        }
        next = { x, y, w, h };
      }
      setSel(clampSel(next, disp));
    };
    const onUp = (): void => {
      drag.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [disp]);

  const onConfirmClick = async (): Promise<void> => {
    const im = imgRef.current;
    if (!im || !disp || !sel) return;
    const ratio = im.naturalWidth / disp.w; // 显示 → 原图
    const sx = sel.x * ratio;
    const sy = sel.y * ratio;
    const sw = sel.w * ratio;
    const sh = sel.h * ratio;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw));
    canvas.height = Math.max(1, Math.round(sh));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(im, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (blob) await onConfirm(blob);
  };

  const handle = (mode: 'nw' | 'ne' | 'sw' | 'se', style: React.CSSProperties): JSX.Element => (
    <div
      onMouseDown={startDrag(mode)}
      style={style}
      className="absolute h-3 w-3 rounded-full border border-accent bg-canvas"
    />
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="flex flex-col rounded-lg border border-border bg-elevated shadow-pop"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-medium text-text-primary">{t('crop.title')}</span>
          <button type="button" onClick={onCancel} className="text-text-tertiary hover:text-text-secondary">
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div className="flex justify-center px-5 py-5">
          {blobUrl ? (
            // 容器尺寸在 onImgLoad 算出 disp 后才定；img 一就绪即挂载触发 onLoad（别用 disp 门控 img，
            // 否则 disp 由 onLoad 设、img 由 disp 挂 → 互相等待死锁）。
            <div
              className="relative select-none"
              style={disp ? { width: disp.w, height: disp.h } : undefined}
            >
              <img
                ref={imgRef}
                src={blobUrl}
                onLoad={onImgLoad}
                draggable={false}
                alt=""
                style={disp ? { width: disp.w, height: disp.h } : { maxWidth: MAX_DISPLAY, maxHeight: MAX_DISPLAY }}
              />
              {sel && disp ? (
                <>
                  {/* 选区外暗化（四条遮罩） */}
                  <div className="pointer-events-none absolute inset-0">
                    <div
                      className="absolute border border-accent"
                      style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h, boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)' }}
                    />
                  </div>
                  <div
                    onMouseDown={startDrag('move')}
                    className="absolute cursor-move"
                    style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }}
                  />
                  {handle('nw', { left: sel.x - 6, top: sel.y - 6, cursor: 'nwse-resize' })}
                  {handle('ne', { left: sel.x + sel.w - 6, top: sel.y - 6, cursor: 'nesw-resize' })}
                  {handle('sw', { left: sel.x - 6, top: sel.y + sel.h - 6, cursor: 'nesw-resize' })}
                  {handle('se', { left: sel.x + sel.w - 6, top: sel.y + sel.h - 6, cursor: 'nwse-resize' })}
                </>
              ) : null}
            </div>
          ) : (
            <div className="flex h-40 w-60 items-center justify-center text-xs text-text-tertiary">
              {t('common:loading')}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border bg-elevated px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-hover"
          >
            {t('common:cancel')}
          </button>
          <button
            type="button"
            onClick={() => void onConfirmClick()}
            className="rounded-md border border-accent bg-accent px-3 py-1.5 text-xs text-canvas transition-colors hover:opacity-90"
          >
            {t('crop.confirm')}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
