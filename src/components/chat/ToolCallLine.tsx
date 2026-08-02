import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, Wrench } from 'lucide-react';
import { motion } from 'framer-motion';
import type { ToolCall, ToolCallVisual } from '@shared/types';
import type { BgCommandView } from '@shared/protocol';
import { normalizeToolName } from '@shared/agent/toolName';
import { readStructuredMarkers } from '@shared/agent/structuredMarkers';
import { cn } from '@/lib/cn';
import { toolImageUrl } from '@/lib/fileUrl';
import { basename } from '@/lib/paths';
import { wsClient } from '@/lib/ws';
import { canOpenTarget, fileChangeTargets } from '@/lib/toolFileTargets';
import { openProjectFile } from '@/lib/openProjectFile';
import { useProjectStore } from '@/stores/projectStore';
import { useBgCommandStore } from '@/stores/bgCommandStore';
import { DiffBlock, isUnifiedDiff } from '../diff/DiffBlock';
import { CopyButton } from '../ui/CopyButton';
import { Dialog } from '../ui/Dialog';

// 状态点四色 = 设计稿全站语义（不变量）：排队灰 / 进行中绿脉冲 / 成功绿 / 失败红。
// 失败全程只靠颜色标识，不配文字（2026-07-20 拍板）。
const statusDot: Record<ToolCall['status'], string> = {
  pending: 'bg-text-tertiary',
  running: 'bg-accent animate-pulse',
  success: 'bg-success',
  error: 'bg-danger',
};

/**
 * 消息已定居（done，含中断落盘）后，悬空的 running/pending 不再是"进行中"——
 * 按排队灰渲染，不让历史消息里的绿点无限脉冲（中断落盘按原 status 保留悬空工具）。
 */
function displayStatus(tool: ToolCall, settled: boolean): ToolCall['status'] {
  if (settled && (tool.status === 'running' || tool.status === 'pending')) return 'pending';
  return tool.status;
}

/** bash 后台命令的登记表 id（主进程启动落盘时附带的结构化标记）；非后台命令返回 null */
function bgCommandIdOf(tool: ToolCall): string | null {
  if (normalizeToolName(tool.name) !== 'bash') return null;
  const id = readStructuredMarkers(tool.result?.structured).backgroundCommand?.id;
  return typeof id === 'string' ? id : null;
}

/**
 * 后台命令的行状态：跑着 = 绿脉冲（活的、跨回合），结束按真实结局定成败——
 * 工具调用本身恒 success（"已启动"），照抄它会把跑挂的后台命令谎报成绿。
 */
function bgStatus(bg: BgCommandView): ToolCall['status'] {
  if (bg.status === 'running') return 'running';
  return bg.status === 'exited' && bg.exitCode === 0 && !bg.timedOut ? 'success' : 'error';
}

/** 运行时长 mm:ss（超 1 小时 h:mm:ss），随 tick 走 */
function fmtElapsed(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h > 0 ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/** 每秒 tick（仅后台命令运行中挂载）——驱动时长实时刷新 */
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * 工具调用行：无框一行小字（状态点 + mono 工具名），把干扰降到叙述流的脚注级。
 * 点击上详情浮层——详情是偶发的深究动作，不进正文流（2026-07-20 拍板）。
 */
export function ToolCallLine({ tool, settled = false }: { tool: ToolCall; settled?: boolean }) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  // claude-code 落盘的 name 带 mcp__oru__ 前缀——展示前剥掉，不露内部代号
  const displayName = normalizeToolName(tool.name);
  // 后台命令：状态以登记表实时数据为准（跨回合活着），settled 不压它的脉冲。
  // 行文字用命令本身而非工具名——两条后台命令若都只写 `bash`，用户认不出哪条在跑（拍板稿：mono 命令）。
  const bgId = bgCommandIdOf(tool);
  const bg = useBgCommandStore((s) => (bgId ? s.byId[bgId] : undefined));
  const status = bg ? bgStatus(bg) : displayStatus(tool, settled);
  const bgRunning = bg?.status === 'running';
  const now = useNowTick(bgRunning === true);
  const bgCommand = bgId && typeof tool.input.command === 'string' ? tool.input.command : null;
  const label = bgCommand ?? displayName;

  return (
    <>
      <motion.button
        type="button"
        initial={{ opacity: 0, y: 2 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        onClick={() => setOpen(true)}
        aria-label={t('toolCall.aria', { name: displayName })}
        className="flex items-center gap-2 self-start rounded-xs px-1 py-0.5 text-left transition-colors duration-150 hover:bg-hover"
      >
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDot[status])} />
        <span
          className={cn(
            'max-w-[280px] truncate font-mono text-xs',
            status === 'error' ? 'text-danger' : 'text-text-tertiary',
          )}
        >
          {label}
        </span>
        {bgRunning && bg ? (
          <span className="text-xs text-text-tertiary">
            {t('toolCall.bgRunning', { elapsed: fmtElapsed(bg.startedAt, now) })}
          </span>
        ) : null}
      </motion.button>
      <ToolCallDetailDialog
        tool={tool}
        status={status}
        bgId={bgId}
        bgRunning={bgRunning === true}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** 耗时（完成后才有）：设计稿工具卡头的 0.4s 样式 */
function duration(tool: ToolCall): string | null {
  if (tool.finishedAt == null) return null;
  return `${((tool.finishedAt - tool.startedAt) / 1000).toFixed(1)}s`;
}

/**
 * 详情浮层：头部 = 扳手 + mono 工具名 + 耗时 + 状态点（设计稿卡头语言），
 * 内容 = 输入 / 结果（或运行中的实时输出），沿用原展开面板的块。
 */
function ToolCallDetailDialog({
  tool,
  status,
  bgId,
  bgRunning,
  open,
  onClose,
}: {
  tool: ToolCall;
  status: ToolCall['status'];
  bgId: string | null;
  bgRunning: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('chat');
  const elapsed = duration(tool);
  // 后台命令输出：开浮层拉一次尾部，跑着时 2s 轮询刷新（输出在磁盘上持续追加）
  const [bgOutput, setBgOutput] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !bgId) return;
    let cancelled = false;
    const pull = () => {
      void wsClient
        .request({ type: 'bgCommand.output', id: bgId })
        .then((res) => {
          if (!cancelled && res.type === 'bgCommand.output.result') setBgOutput(res.text);
        })
        .catch(() => {});
    };
    pull();
    // 已结束也要 cleanup：初始那次请求在途时关浮层，不做无效 setState
    if (!bgRunning) {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(pull, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, bgId, bgRunning]);
  // 写盘类工具且目标在活跃项目内可开：头部右上角给「在 Oru 中打开」（2026-07-20 拍板：方案 A 兜底入口）。
  // 打开判定统一走 canOpenTarget（仍存在 + 当前项目 + 类型可开）；bash 可多文件，逐个给按钮。
  const projectId = useProjectStore((s) => s.activeProjectId);
  const targets = fileChangeTargets(tool).filter((t) => canOpenTarget(t, projectId));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="w-[min(640px,calc(100vw-32px))]"
      headerActions={
        targets.length > 0 ? (
          // bash 可核实出多个文件：按钮组自己可收缩、可换行（Dialog 的动作容器 shrink-0
          // 是护关闭按钮的，不动它），标题的 truncate 不被按钮串挤没
          <div className="flex min-w-0 flex-wrap justify-end gap-1.5">
            {targets.map((target) => (
              <button
                key={`${target.projectId}:${target.relPath}`}
                type="button"
                title={target.relPath}
                onClick={() => {
                  openProjectFile(target.projectId, target.relPath);
                  onClose();
                }}
                className="flex items-center gap-1 rounded-xs border border-accent-line px-2 py-0.5 text-xs text-accent-deep transition-colors hover:bg-accent-soft"
              >
                <ArrowUpRight size={12} strokeWidth={1.8} />
                {targets.length > 1
                  ? basename(target.relPath)
                  : t('toolCall.openInOru')}
              </button>
            ))}
          </div>
        ) : null
      }
      title={
        <span className="flex items-center gap-2">
          <Wrench size={14} strokeWidth={1.5} className="text-text-secondary" />
          <span className="font-mono text-sm text-text-primary">{normalizeToolName(tool.name)}</span>
          {elapsed ? <span className="text-xs text-text-tertiary">{elapsed}</span> : null}
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDot[status])} />
        </span>
      }
    >
      <div className="max-h-[60vh] overflow-y-auto text-xs text-text-secondary">
        {tool.visual ? <VisualBlock visual={tool.visual} /> : null}
        <div className="mb-2">
          <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wider text-text-tertiary">
            <span>{t('toolCall.input')}</span>
            <CopyButton text={JSON.stringify(tool.input, null, 2)} className="ml-auto" />
          </div>
          <pre className="whitespace-pre-wrap break-words rounded-xs border border-border bg-sunken/40 px-3 py-2 font-mono text-xs leading-relaxed text-text-primary">
            {JSON.stringify(tool.input, null, 2)}
          </pre>
        </div>
        {bgId && bgOutput !== null ? (
          // 后台命令：登记表输出文件的尾部（跑着时轮询刷新），取代"已启动"回执成为主内容
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">
              {t('toolCall.liveOutput')}
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xs border border-border bg-sunken/40 px-3 py-2 font-mono text-xs leading-relaxed text-text-primary">
              {bgOutput}
            </pre>
          </div>
        ) : tool.result ? (
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">
              {t('toolCall.result')}{tool.result.isError ? t('toolCall.resultError') : ''}
            </div>
            <ResultBody body={tool.result.detail ?? tool.result.summary} isError={tool.result.isError} />
          </div>
        ) : tool.commandOutput ? (
          // G19：结果未到、命令执行中——滚动显示实时输出（只给人看）。结果到达即由上面的 result 接管。
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">
              {t('toolCall.liveOutput')}
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xs border border-border bg-sunken/40 px-3 py-2 font-mono text-xs leading-relaxed text-text-primary">
              {tool.commandOutput}
            </pre>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * 图片工具的视觉块（决策 8）：
 * - image_search：模型看过的候选缩略图网格 + "看了 N 张 · 用了 <engine>"。
 * - download_image：落地图 + 相对路径 + 来源 host。
 * 图走 oru-toolimg:// 协议加载（主窗口不能 file://）。"选用高亮"本期不做。
 */
function VisualBlock({ visual }: { visual: ToolCallVisual }) {
  const { t } = useTranslation('chat');
  if (visual.kind === 'image_search') {
    if (visual.thumbnails.length === 0) return null;
    return (
      <div className="mb-2">
        <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">
          {t('toolCall.candidates', { count: visual.thumbnails.length })}
          {visual.engineUsed ? ` · ${visual.engineUsed}` : ''}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {visual.thumbnails.map((thumb, i) => (
            <a
              key={i}
              href={thumb.contentUrl ?? toolImageUrl(thumb.imgPath)}
              target="_blank"
              rel="noreferrer"
              title={thumb.contentUrl ?? ''}
              className="block"
            >
              <img
                src={toolImageUrl(thumb.imgPath)}
                alt={t('toolCall.candidateAlt', { n: i + 1 })}
                className="h-20 w-28 rounded border border-border bg-canvas object-cover"
              />
            </a>
          ))}
        </div>
      </div>
    );
  }
  // download_image
  return (
    <div className="mb-2">
      <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">
        {t('toolCall.imageAdded')}
        {visual.sourceHost ? t('toolCall.fromHost', { host: visual.sourceHost }) : ''}
      </div>
      <div className="flex items-start gap-2">
        <img
          src={toolImageUrl(visual.imgPath)}
          alt={visual.relPath}
          className="h-24 max-w-[200px] rounded border border-border bg-canvas object-cover"
        />
        <code className="mt-1 break-all rounded bg-canvas px-1.5 py-0.5 font-mono text-xs text-text-secondary">
          {visual.relPath}
        </code>
      </div>
    </div>
  );
}

/** 工具结果体：内容是 unified diff（信任模式 edit_file/write_file 落盘）时着色渲染，否则纯文本。 */
function ResultBody({ body, isError }: { body: string; isError?: boolean }) {
  if (!isError && isUnifiedDiff(body)) return <DiffBlock diff={body} />;
  return (
    <pre
      className={cn(
        'whitespace-pre-wrap break-words rounded-xs border border-border bg-sunken/40 px-3 py-2 font-mono text-xs leading-relaxed',
        isError ? 'text-danger' : 'text-text-primary',
      )}
    >
      {body}
    </pre>
  );
}
