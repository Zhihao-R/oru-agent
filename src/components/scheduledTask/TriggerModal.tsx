/**
 * 「添加触发时间」独立弹窗——照设计稿「定时触发器」组件 1:1 复刻。
 * 计时器（时长后执行 N 次）/ 闹钟（时刻 + 星期 + 一直/N 次）两模式；时/分/次数用无框数字域，
 * 滚轮 / 上下拖动 / 键盘三种输入。视觉 token 走 src/index.css。
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import { describeWhen } from '@/lib/scheduledTaskFormat';
import { describeForm, formValid, type SpecForm } from './specForm';

// 后端 weekday 0=周日..6=周六；界面周一为首列 → 列 i 对应后端 (i+1)%7
const WD_COLS = [1, 2, 3, 4, 5, 6, 0];

/** 无框数字域：滚轮 / 上下拖动 / 键盘。value 受控，wrap=超界循环、pad=补零。 */
function NumField({
  value,
  min,
  max,
  wrap,
  pad,
  onChange,
  className,
}: {
  value: number;
  min: number;
  max: number;
  wrap?: boolean;
  pad?: boolean;
  onChange: (v: number) => void;
  className?: string;
}) {
  const drag = useRef<{ y: number; base: number } | null>(null);
  const span = max - min + 1;
  const clamp = (v: number) =>
    isNaN(v) ? min : wrap ? (((v - min) % span) + span) % span + min : Math.max(min, Math.min(max, v));
  return (
    <input
      inputMode="numeric"
      maxLength={String(max).length}
      value={pad ? String(value).padStart(2, '0') : String(value)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^0-9]/g, '');
        onChange(raw === '' ? min : clamp(parseInt(raw, 10)));
      }}
      onWheel={(e) => {
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        onChange(clamp(value + (e.deltaY < 0 ? 1 : -1)));
      }}
      onPointerDown={(e) => {
        drag.current = { y: e.clientY, base: value };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || e.buttons === 0) return;
        onChange(clamp(d.base + Math.round((d.y - e.clientY) / 7)));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      className={cn(
        'cursor-ns-resize border-none bg-transparent text-center font-mono outline-none [caret-color:theme(colors.accent.DEFAULT)]',
        className,
      )}
    />
  );
}

/** 时:分大号显示 + 「滚动·拖动·输入」提示。 */
function BigTime({
  h,
  m,
  wrap,
  onH,
  onM,
}: {
  h: number;
  m: number;
  wrap?: boolean;
  onH: (v: number) => void;
  onM: (v: number) => void;
}) {
  const { t } = useTranslation('scheduledTask');
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-center gap-3 pt-2">
        <div className="flex flex-col items-center gap-1">
          <span className="text-[11px] tracking-wider text-text-tertiary">{t('wheel.hour')}</span>
          <NumField value={h} min={0} max={23} wrap={wrap} pad onChange={onH} className="w-[2.2ch] text-[40px] font-medium text-text-primary" />
        </div>
        <span className="pb-1.5 font-mono text-[38px] text-text-tertiary">:</span>
        <div className="flex flex-col items-center gap-1">
          <span className="text-[11px] tracking-wider text-text-tertiary">{t('wheel.minute')}</span>
          <NumField value={m} min={0} max={59} wrap={wrap} pad onChange={onM} className="w-[2.2ch] text-[40px] font-medium text-text-primary" />
        </div>
      </div>
      <div className="flex justify-center">
        <span className="inline-flex items-center gap-1 text-[10.5px] text-text-tertiary">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2.5v11M4.5 6 8 2.5 11.5 6M4.5 10 8 13.5 11.5 10" />
          </svg>
          {t('wheel.hint')}
        </span>
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, label, timer }: { active: boolean; onClick: () => void; label: string; timer?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 rounded px-0 py-1.5 text-center text-xs transition-colors',
        active ? 'bg-[var(--segment-on)] font-semibold text-[var(--segment-on-fg)]' : 'text-text-tertiary hover:text-text-secondary',
      )}
    >
      <span className="inline-flex items-center justify-center gap-1.5">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          {timer ? (
            <>
              <path d="M6 1.5h4M8 4.5v4l2.5 2" />
              <circle cx="8" cy="9" r="5" />
            </>
          ) : (
            <>
              <circle cx="8" cy="9" r="5" />
              <path d="M8 6.5V9l2 1.2M2.5 4 5 2M13.5 4 11 2" />
            </>
          )}
        </svg>
        {label}
      </span>
    </button>
  );
}

export function TriggerModal({
  initial,
  editing,
  onCancel,
  onSave,
}: {
  initial: SpecForm;
  editing: boolean;
  onCancel: () => void;
  onSave: (form: SpecForm) => void;
}) {
  const { t } = useTranslation('scheduledTask');
  const [form, setForm] = useState<SpecForm>(initial);
  const valid = formValid(form);

  const patch = (p: Partial<SpecForm>) => setForm((f) => ({ ...f, ...p } as SpecForm));
  // 计时器：改任一字段即清掉 frozen at（回填的既有 once 一经编辑就变成新的时长）
  const patchTimer = (p: Partial<Extract<SpecForm, { mode: 'timer' }>>) =>
    setForm((f) => ({ ...(f as Extract<SpecForm, { mode: 'timer' }>), ...p, at: undefined }));

  const sentence = valid ? describeForm(form, t) : t('rule.timerNeedDuration');
  const nextWhen = valid ? nextFireWhen(form) : '';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onMouseDown={onCancel}>
      <div
        className="flex w-[460px] flex-col overflow-hidden rounded-lg border border-border bg-elevated shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 pt-4">
          <span className="font-serif text-[16.5px] font-semibold tracking-tight text-text-primary">
            {editing ? t('rule.editTitle') : t('rule.addTitle')}
          </span>
          <span className="flex-1" />
          <button onClick={onCancel} className="grid h-[26px] w-[26px] place-items-center rounded text-text-tertiary transition-colors hover:bg-sunken hover:text-text-primary">
            <X size={12} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 pt-4">
          {/* 模式段 */}
          <div className="flex rounded-md border border-border bg-sunken p-0.5">
            <ModeButton active={form.mode === 'timer'} timer onClick={() => setForm(toTimer(form))} label={t('mode.timer')} />
            <ModeButton active={form.mode === 'alarm'} onClick={() => setForm(toAlarm(form))} label={t('mode.alarm')} />
          </div>

          {form.mode === 'timer' ? (
            <div className="flex flex-col gap-4">
              <BigTime h={form.h} m={form.m} onH={(v) => patchTimer({ h: v })} onM={(v) => patchTimer({ m: v })} />
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] tracking-wide text-text-tertiary">{t('rule.timerCountLabel')}</span>
                <div className="flex items-center gap-1.5 rounded-md border border-border-strong bg-elevated px-3.5 py-2.5">
                  <span className="text-[12.5px] text-text-secondary">{t('rule.timerRun')}</span>
                  <NumField value={form.count} min={1} max={999} onChange={(v) => patchTimer({ count: v })} className="w-[3ch] text-base font-medium text-accent-deep" />
                  <span className="text-[12.5px] text-text-secondary">{t('rule.timerTimes')}</span>
                  <span className="flex-1" />
                  <span className="text-[11px] text-text-tertiary">{t('rule.timerOnceHint')}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <BigTime h={form.h} m={form.m} wrap onH={(v) => patch({ h: v })} onM={(v) => patch({ m: v })} />
              {/* 星期 */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] tracking-wide text-text-tertiary">{t('rule.weekLabel')}</span>
                  {form.days.length === 0 ? (
                    <span className="text-[11px] text-accent-deep">{t('rule.everyDayHint')}</span>
                  ) : null}
                </div>
                <div className="flex gap-1 rounded-md border border-border-strong bg-elevated p-1">
                  {WD_COLS.map((backendDay) => {
                    const on = form.days.includes(backendDay);
                    const labels = t('weekdaysShort', { returnObjects: true }) as string[]; // 索引=后端 weekday
                    return (
                      <button
                        key={backendDay}
                        onClick={() =>
                          patch({
                            days: on ? form.days.filter((d) => d !== backendDay) : [...form.days, backendDay],
                          })
                        }
                        className={cn(
                          'flex-1 rounded px-0 py-1.5 text-center text-xs transition-colors',
                          on ? 'bg-accent text-accent-fg' : 'text-text-tertiary hover:text-text-secondary',
                        )}
                      >
                        {labels[backendDay]}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* 重复次数 */}
              <div className="flex flex-col gap-2">
                <span className="text-[11px] tracking-wide text-text-tertiary">{t('rule.repeatLabel')}</span>
                <div className="flex items-center overflow-hidden rounded-md border border-border-strong bg-elevated">
                  <button
                    onClick={() => patch({ countMode: 'forever' })}
                    className={cn(
                      'flex-1 py-2.5 text-center text-[12.5px] transition-colors',
                      form.countMode === 'forever' ? 'bg-accent-soft font-semibold text-accent-deep' : 'text-text-tertiary',
                    )}
                  >
                    {t('rule.stopForever')}
                  </button>
                  <span className="w-px self-stretch bg-border" />
                  <button
                    onClick={() => patch({ countMode: 'n' })}
                    className={cn(
                      'inline-flex flex-1 items-center justify-center gap-2 py-2.5 text-[12.5px] transition-colors',
                      form.countMode === 'n' ? 'bg-accent-soft font-semibold text-accent-deep' : 'text-text-tertiary',
                    )}
                  >
                    {t('rule.timerCount')}
                    <NumField value={form.count} min={1} max={999} onChange={(v) => patch({ countMode: 'n', count: v })} className="w-[3ch] text-sm font-semibold text-inherit" />
                    {t('rule.timerTimes')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 预览横幅 */}
          <div className="flex items-center gap-2 rounded-md border border-accent-ring bg-accent-soft px-3.5 py-2.5">
            <Check size={13} className="shrink-0 text-accent-deep" strokeWidth={2} />
            <span className="text-[12.5px] text-accent-deep">{sentence}</span>
            <span className="flex-1" />
            {nextWhen ? (
              <span className="text-[11px] text-accent-deep" style={{ opacity: 0.75 }}>
                {t('rule.nextAt', { when: nextWhen })}
              </span>
            ) : null}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2.5 border-t border-border px-5 py-4">
          <span className="flex-1" />
          <button onClick={onCancel} className="rounded-full border border-border-strong bg-elevated px-4 py-1.5 text-[12.5px] text-text-secondary hover:text-text-primary">
            {t('common:cancel')}
          </button>
          <button
            disabled={!valid}
            onClick={() => onSave(form)}
            className={cn(
              'rounded-full px-[18px] py-1.5 text-[12.5px]',
              valid ? 'bg-accent text-accent-fg' : 'cursor-not-allowed bg-sunken text-text-tertiary',
            )}
          >
            {editing ? t('common:save') : t('rule.add')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 切模式：保时刻不保结构。切到计时器给「时长 = 当前时刻的 h:m、执行 1 次」不合适，用 30 分钟默认。 */
function toTimer(f: SpecForm): SpecForm {
  return f.mode === 'timer' ? f : { mode: 'timer', h: 0, m: 30, count: 1 };
}
function toAlarm(f: SpecForm): SpecForm {
  return f.mode === 'alarm' ? f : { mode: 'alarm', h: 8, m: 0, days: [], countMode: 'forever', count: 8 };
}

/** 本地估算下次触发的人话（仅供弹窗即时预览；权威调度在主进程）。 */
function nextFireWhen(f: SpecForm): string {
  const now = Date.now();
  if (f.mode === 'timer') {
    if (f.at != null) return describeWhen(f.at, now);
    const total = f.h * 60 + f.m;
    return total > 0 ? describeWhen(now + total * 60_000, now) : '';
  }
  const d = new Date(now);
  for (let off = 0; off < 8; off += 1) {
    const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate() + off, f.h, f.m, 0, 0);
    const hit = f.days.length === 0 || f.days.includes(cand.getDay());
    if (hit && cand.getTime() > now) return describeWhen(cand.getTime(), now);
  }
  return '';
}
