/**
 * 持久授权稳定键的单一事实源（S24 · G30）——工具侧（emit 分流 / grants store）与设置页
 * （已授权清单撤销）共用同一份键推导，任何一处偏移都会让「已授权」判定与撤销对不上。
 *
 * 单例整类是常量键；category 加 `category:` 前缀与单例及 delivery 命名空间区隔；delivery
 * 复用 `${channel}:${recipient}` 的收件人＋渠道最窄粒度（被骗后损失面最小，对齐
 * deliveryGate.ts 的 deliveryGrantKey 格式），加 `delivery:` 前缀。
 */
import type { GrantScope } from '../types';

export function grantKey(s: GrantScope): string {
  switch (s.kind) {
    case 'destructive':
    case 'unknown':
    case 'overwrite':
      return s.kind;
    case 'category':
      return `category:${s.id}`;
    case 'delivery':
      return `delivery:${s.channel}:${s.recipient}`;
  }
}
