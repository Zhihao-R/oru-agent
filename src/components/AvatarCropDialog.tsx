/**
 * 头像裁剪对话框：拖动 + 缩放滑块 + canvas 输出 512×512 圆形 PNG
 *
 * 关键设计：
 *  - 240×240 圆形预览框，原图通过 transform: translate + scale 定位
 *  - coverScale = 让图片最短边等于预览圆直径（slider 的 min；初始值）
 *  - maxScale = coverScale * 3
 *  - 拖动约束：图片必须始终覆盖整个圆（边缘不能露出预览框背景）
 *  - 输出：canvas 圆形 clip + drawImage 按 transform 推算
 *
 * 不引入第三方库，避免 npm 依赖膨胀。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';

const PREVIEW_SIZE = 240;
const OUTPUT_SIZE = 512;
const MAX_SCALE_MULTIPLIER = 3;

type Props = {
  file: File;
  onConfirm: (pngBlob: Blob) => void | Promise<void>;
  onCancel: () => void;
};

export function AvatarCropDialog({ file, onConfirm, onCancel }: Props) {
  const { t } = useTranslation('profile');
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [coverScale, setCoverScale] = useState(1);
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const imgRef = useRef<HTMLImageElement>(null);

  // 加载 file 成 url
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // 图片加载完成 → 计算 cover scale
  const onImgLoad = () => {
    if (!imgRef.current) return;
    const w = imgRef.current.naturalWidth;
    const h = imgRef.current.naturalHeight;
    setImgSize({ w, h });
    const cover = Math.max(PREVIEW_SIZE / w, PREVIEW_SIZE / h);
    setCoverScale(cover);
    setScale(cover);
    setTranslate({ x: 0, y: 0 });
  };

  // 约束 translate 不让图片露出空白
  const clampTranslate = (
    t: { x: number; y: number },
    s: number,
    size: { w: number; h: number },
  ): { x: number; y: number } => {
    const displayW = size.w * s;
    const displayH = size.h * s;
    const maxTx = Math.max(0, (displayW - PREVIEW_SIZE) / 2);
    const maxTy = Math.max(0, (displayH - PREVIEW_SIZE) / 2);
    return {
      x: Math.max(-maxTx, Math.min(maxTx, t.x)),
      y: Math.max(-maxTy, Math.min(maxTy, t.y)),
    };
  };

  useEffect(() => {
    if (!imgSize) return;
    setTranslate((t) => clampTranslate(t, scale, imgSize));
  }, [scale, imgSize]);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      tx: translate.x,
      ty: translate.y,
    };
  };

  useEffect(() => {
    if (!dragging || !imgSize) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setTranslate(
        clampTranslate(
          { x: dragStart.current.tx + dx, y: dragStart.current.ty + dy },
          scale,
          imgSize,
        ),
      );
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, scale, imgSize]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY * -0.002 * coverScale;
    setScale((s) =>
      Math.max(coverScale, Math.min(coverScale * MAX_SCALE_MULTIPLIER, s + delta)),
    );
  };

  const onConfirmClick = async () => {
    if (!imgRef.current || !imgSize) return;
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // 圆形蒙版
    ctx.beginPath();
    ctx.arc(OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, OUTPUT_SIZE / 2, 0, Math.PI * 2);
    ctx.clip();
    // 把预览的 transform 等比放大到 OUTPUT_SIZE 坐标
    const ratio = OUTPUT_SIZE / PREVIEW_SIZE;
    const drawW = imgSize.w * scale * ratio;
    const drawH = imgSize.h * scale * ratio;
    const dx = OUTPUT_SIZE / 2 - drawW / 2 + translate.x * ratio;
    const dy = OUTPUT_SIZE / 2 - drawH / 2 + translate.y * ratio;
    ctx.drawImage(imgRef.current, dx, dy, drawW, drawH);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (blob) await onConfirm(blob);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="flex w-[420px] max-w-[92vw] flex-col rounded-lg border border-border bg-elevated shadow-pop"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-medium text-text-primary">{t('crop.title')}</span>
          <button
            type="button"
            onClick={onCancel}
            className="text-text-tertiary hover:text-text-secondary"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
        <div className="px-5 py-5">
          <div className="flex justify-center">
            <div
              className="relative cursor-move overflow-hidden rounded-full bg-sunken"
              style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
              onMouseDown={onMouseDown}
              onWheel={onWheel}
            >
              {imgUrl ? (
                <img
                  ref={imgRef}
                  src={imgUrl}
                  draggable={false}
                  onLoad={onImgLoad}
                  alt=""
                  className="absolute select-none"
                  style={{
                    left: '50%',
                    top: '50%',
                    transform: `translate(calc(-50% + ${translate.x}px), calc(-50% + ${translate.y}px)) scale(${scale})`,
                    transformOrigin: 'center center',
                    maxWidth: 'none',
                    maxHeight: 'none',
                  }}
                />
              ) : null}
            </div>
          </div>
          <div className="mt-5 flex items-center gap-3">
            <span className="text-xs text-text-tertiary">{t('crop.zoom')}</span>
            <input
              type="range"
              min={coverScale}
              max={coverScale * MAX_SCALE_MULTIPLIER}
              step={0.001}
              value={scale}
              onChange={(e) => setScale(parseFloat(e.target.value))}
              className="flex-1 accent-accent"
            />
          </div>
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
            onClick={onConfirmClick}
            className="rounded-md border border-accent bg-accent px-3 py-1.5 text-xs text-canvas transition-colors hover:opacity-90"
          >
            {t('crop.confirm')}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
