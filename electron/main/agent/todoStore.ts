/**
 * 计划清单（todo）的按对话存储——内存优先 + 磁盘兜底。
 *
 * 落盘是为了让清单活过重启与上下文压缩：它每轮要贴回模型眼前、也要在前端连上时取初值，
 * 只存内存的话「重启即清」等于每次重启都把用户的计划丢掉。盘上最终只会留下没了结的那份
 * （全部终结的清单在下一轮开始时删掉，见 todoSweep）。
 *
 * 读写整块串行（createWriteQueue 单 chain）：工具的写路径是「读 → 比对上一版 → 落盘」，中间有
 * await，与回合边界的 clearTodos 有交叉窗口（CLAUDE.md「RMW 整块入锁」）。锁内一律走未加锁的
 * loadTodos / persist，绝不再 enqueue 同 chain（会等自己）。
 */
import { promises as fs } from 'node:fs';
import type { TodoItem } from '@shared/types';
import { conversationTodoFile } from '../runtime/paths';
import { createWriteQueue } from '../runtime/atomicStore';
import { noteCorruption } from '../runtime/storageCorruption';

const memory = new Map<string, TodoItem[]>();
const { enqueue, writeAtomic } = createWriteQueue();

/** 锁内用：内存命中即返回，否则回读磁盘并缓存（解析失败按空清单降级 + 留痕）。 */
async function loadTodos(ownerId: string, agentId: string, convId: string): Promise<TodoItem[]> {
  const cached = memory.get(convId);
  if (cached) return cached;
  const file = conversationTodoFile(ownerId, agentId, convId);
  let items: TodoItem[] = [];
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('计划清单不是数组');
    items = parsed as TodoItem[];
  } catch (e) {
    // 没写过（ENOENT）是常态，不是损坏——只有真读坏了才留痕
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      noteCorruption('agent/todo', `读计划清单失败 ${file}（${String(e)}）——按空清单降级`);
    }
  }
  memory.set(convId, items);
  return items;
}

/** 锁内用：写内存 + 原子落盘。 */
async function persist(ownerId: string, agentId: string, convId: string, items: TodoItem[]): Promise<void> {
  memory.set(convId, items);
  await writeAtomic(conversationTodoFile(ownerId, agentId, convId), JSON.stringify(items, null, 2));
}

/** 取某对话当前计划清单（每轮注入 / 前端取初值 / 工具读回执用）。 */
export function getTodos(ownerId: string, agentId: string, convId: string): Promise<TodoItem[]> {
  return enqueue(() => loadTodos(ownerId, agentId, convId));
}

/** 覆盖某对话的计划清单。工具写路径走 updateTodos（要跟上一版比对），这里是不需比对时的直写。 */
export function setTodos(ownerId: string, agentId: string, convId: string, items: TodoItem[]): Promise<void> {
  return enqueue(() => persist(ownerId, agentId, convId, items));
}

/**
 * 读改写整块入锁：mutate 拿到当前清单、返回新清单，落盘后原样返回给调用方。
 * store 只跑这个回调、不懂它在算什么——「这是不是抹账」那类语义判断留在工具层。
 */
export function updateTodos(
  ownerId: string,
  agentId: string,
  convId: string,
  mutate: (prev: TodoItem[]) => TodoItem[],
): Promise<TodoItem[]> {
  return enqueue(async () => {
    const next = mutate(await loadTodos(ownerId, agentId, convId));
    await persist(ownerId, agentId, convId, next);
    return next;
  });
}

/** 删掉某对话的清单（了结后清掉 / 对话被删或被清空）——删盘也删内存。 */
export function clearTodos(ownerId: string, agentId: string, convId: string): Promise<void> {
  return enqueue(async () => {
    memory.set(convId, []);
    await fs.rm(conversationTodoFile(ownerId, agentId, convId), { force: true });
  });
}

/** 测试用：清零内存缓存（不碰磁盘——模拟重启就靠它）。 */
export function __resetTodoStoreForTest(): void {
  memory.clear();
}
