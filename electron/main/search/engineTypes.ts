/**
 * 运行时的已知引擎类型集合——设置反序列化层过滤未知 type 用（可移除性地基）。
 *
 * Record 形式让编译器双向核对：SearchEngineType 增删成员这里必跟（缺 key / 多 key 都红），
 * 与 selector.makeEngine 的 switch 穷尽检查同受该联合约束——两处不会漂移。
 * 独立成模块而非放 selector.ts：消费方是 projects/store 的反序列化层，而 selector 又
 * import store（getSettings）——放 selector 会成 import 环。
 */
import type { SearchEngineType } from '@shared/types';

const KNOWN: Record<SearchEngineType, true> = { bocha: true, tavily: true, anysearch: true };

export function isKnownEngineType(t: unknown): t is SearchEngineType {
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(KNOWN, t);
}
