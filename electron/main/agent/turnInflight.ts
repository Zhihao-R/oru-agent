/**
 * 流式实时落盘 · 崩溃恢复草稿（S03 / G22）。
 *
 * steeringBackup 的对称另一侧：那是「用户输入侧」的将生效草稿，这是「AI 产出侧」的流式草稿。
 * 二者同范式——流中即写盘、启动扫描补回、per-conv 一份文件跟着对话数据走：
 *   conversations/<agentId>/<convId>.turn-inflight.json
 *
 * 为什么需要：流式文本原本只累积在内存，回合末（成功）或 catch（优雅中断 / 上游错）才整条落盘。
 * 进程崩溃两条路径都不走 → 这一轮已产出的文字与悬空工具调用随内存整轮蒸发。草稿让崩溃也不丢：
 *   1. 流中把已成形的 partial 节流镜像进草稿；
 *   2. 正式落盘（成功 / 优雅中断）后同步清草稿；
 *   3. 重启扫描残留草稿 → 合成一条 incomplete assistant 消息（interrupted='crashed'）补进历史。
 *
 * 幂等：崩在「正式落盘后、清草稿前」时草稿仍在——扫描按 messageId 查历史已存在则只删草稿、不重复补。
 * 空 partial（一个 token 都没产出）不写草稿、也不补壳（与 buildInterruptedMessage 的空判一致）。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { safeWriteAsync } from '../fs/safeWrite';
import { convDir } from '../runtime/paths';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { appendMessage, readHistoryForOwner } from '../conversations/store';
import { buildInterruptedMessage, type PartialTurn, type TurnMeta } from './interrupted';

const INFLIGHT_SUFFIX = '.turn-inflight.json';

/** 文本节流窗口：流中最多每 THROTTLE_MS 写一次盘（工具边界不特判——节流已足够密，崩溃最多丢 <窗口 的产出）。 */
const THROTTLE_MS = 500;

export type InflightDraft = {
  version: 1;
  messageId: string;
  partial: PartialTurn;
  meta: TurnMeta;
  /** 回合起始时刻——补回合时作 createdAt，比 boot 时刻更贴近它真正发生的时间。 */
  startedAt: number;
};

function inflightFile(agentId: string, convId: string): string {
  return join(convDir(getCurrentOwnerId()), agentId, `${convId}${INFLIGHT_SUFFIX}`);
}

function isEmpty(p: PartialTurn): boolean {
  return p.resultText.length === 0 && p.toolCalls.length === 0;
}

export type InflightWriter = {
  /** 流中每次 partial 更新时调（节流、合并、fire-and-forget）；空 partial 不落盘。 */
  write(partial: PartialTurn): void;
  /** 回合结束时调：取消待写定时器 + 等在途写盘落定，之后调用方再清草稿不会被复活。 */
  stop(): Promise<void>;
};

/**
 * 造一个绑定单回合的节流草稿写手。生命周期由 runner 持有（write 于流中、stop 于回合结束）；
 * 正式落盘后的清草稿由 clearTurnInflight 独立完成（见 runChatAndPersist）。
 */
export function makeInflightWriter(args: {
  agentId: string;
  convId: string;
  messageId: string;
  meta: TurnMeta;
  /**
   * 回合开始时刻（缺省＝构造时刻）。runner 建 writer 在回合起点压缩落卡之后——用构造时刻
   * 会晚于压缩卡 createdAt，崩溃恢复的消息重载后错序到压缩卡后面。传回合入口时刻对齐
   * runChatAndPersist 的同一不变量：回合消息 createdAt 一律盖回合开始。
   */
  startedAt?: number;
}): InflightWriter {
  const file = inflightFile(args.agentId, args.convId);
  const startedAt = args.startedAt ?? Date.now();
  let latest: PartialTurn | null = null;
  let lastWriteAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let stopped = false;

  function schedule(): void {
    if (stopped || !latest || timer) return;
    const since = Date.now() - lastWriteAt;
    if (since >= THROTTLE_MS) void flush();
    else
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, THROTTLE_MS - since);
  }

  async function flush(): Promise<void> {
    if (stopped || inflight) return;
    const p = latest;
    latest = null;
    if (!p || isEmpty(p)) return;
    lastWriteAt = Date.now();
    const draft: InflightDraft = {
      version: 1,
      messageId: args.messageId,
      // 快照当刻文字与工具调用（单线程无撕裂，但拷贝数组避免后续 mutation 回改已排队内容）
      partial: { resultText: p.resultText, toolCalls: [...p.toolCalls] },
      meta: args.meta,
      startedAt,
    };
    inflight = (async () => {
      try {
        await safeWriteAsync(file, JSON.stringify(draft));
      } catch (e) {
        // 草稿写盘失败：崩溃恢复本轮降级（不阻断流式输出，正式落盘路径不受影响）
        console.warn('[turnInflight] 草稿写盘失败（崩溃恢复本轮降级）:', e);
      }
    })();
    await inflight;
    inflight = null;
    // 写盘期间又有更新排进 latest（如首写文字、写盘途中来的悬空工具）→ 补一次，别把末尾更新搁死。
    schedule();
  }

  return {
    write(partial: PartialTurn): void {
      if (stopped || isEmpty(partial)) return;
      latest = partial;
      // 写盘在途时不排队——flush 落定后会 schedule() 补上 latest；否则按节流安排一次写。
      if (inflight) return;
      schedule();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inflight) await inflight;
    },
  };
}

/** 正式落盘（成功 / 优雅中断）后清草稿——rm force 幂等，无草稿也安全。 */
export async function clearTurnInflight(agentId: string, convId: string): Promise<void> {
  await fs.rm(inflightFile(agentId, convId), { force: true });
}

/**
 * 唤醒对账的次级半截源：读该对话的流式草稿。睡眠场景进程内存原地保留，
 * query handler 优先读 runner 内存 partial（readActivePartial），这里只当内存不可读时的回退。
 * 无草稿 / 读取失败 → null。
 */
export async function readTurnInflight(agentId: string, convId: string): Promise<InflightDraft | null> {
  const file = inflightFile(agentId, convId);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const draft = JSON.parse(raw) as Partial<InflightDraft>;
    if (!draft.messageId || !draft.partial) return null;
    return draft as InflightDraft;
  } catch {
    return null;
  }
}

/**
 * 启动扫描（只扫流式草稿，与 steering 扫描并列、互不搅和）。必须在 ws server 接受请求之前跑完：
 * 晚扫会把本进程新回合正在写的活草稿误当崩溃残留。
 *
 * 对每份残留草稿：按 messageId 查该对话历史——已存在（崩在正式落盘后、清草稿前）则只删草稿；
 * 否则用 buildInterruptedMessage(reason='crashed') 合成一条半截补进历史。空 partial 不补壳。
 * 单 conv 失败只告警，不拖累其余（与 steering 扫描同容错口径）。
 */
export async function scanTurnInflightOnBoot(): Promise<void> {
  const root = convDir(getCurrentOwnerId());
  let agentIds: string[];
  try {
    agentIds = await fs.readdir(root);
  } catch {
    return; // conversations 目录还不存在 = 全新安装，无残留
  }
  for (const agentId of agentIds) {
    let names: string[];
    try {
      names = await fs.readdir(join(root, agentId));
    } catch {
      continue; // 非目录条目（如 .DS_Store）
    }
    for (const name of names) {
      if (!name.endsWith(INFLIGHT_SUFFIX)) continue;
      const convId = name.slice(0, -INFLIGHT_SUFFIX.length);
      const file = join(root, agentId, name);
      try {
        const draft = JSON.parse(await fs.readFile(file, 'utf-8')) as Partial<InflightDraft>;
        if (draft.messageId && draft.partial && draft.meta) {
          const history = await readHistoryForOwner(getCurrentOwnerId(), agentId, convId);
          const already = history.some((h) => h.id === draft.messageId);
          if (!already) {
            const msg = buildInterruptedMessage(
              { partial: draft.partial, reason: 'crashed', meta: draft.meta },
              { id: draft.messageId, conversationId: convId },
              draft.startedAt ?? Date.now(),
            );
            if (msg) await appendMessage(agentId, convId, msg);
          }
        }
        await fs.rm(file, { force: true });
      } catch (e) {
        console.warn(`[turnInflight] 崩溃草稿恢复失败（conv=${convId}，本次不补、草稿保留待下次）:`, e);
      }
    }
  }
}
