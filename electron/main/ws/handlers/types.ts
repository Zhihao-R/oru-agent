/**
 * 命令注册表的类型核（D2(a)）——把「协议类型 → 业务」从 router.ts 的赤裸 switch
 * 改成类型安全的查表分发。
 *
 * 第一性收益：`CommandRegistry` 是 mapped type `{ [T in 协议所有 type]: ... }`——
 * 少接一个协议命令**编译期就报错**，把「一百多个命令别漏」从人肉纪律变成类型约束。
 * 这是 switch 给不了的。穷尽约束在合并点 handlers/index.ts 的 `registry: CommandRegistry` 处生效。
 *
 * 单个域文件只覆盖协议的一个子集，故各域 `satisfies RegistrySlice`（= `Partial<CommandRegistry>`）；
 * 全部子集在 index.ts spread 合并成完整 `CommandRegistry`，由 tsc 在那里强制穷尽。
 *
 * 注：handler 直接 import 自己域的子系统（与 router 原 case 同款），单测沿用既有
 * 「真 route() + harness 收 reply/broadcast」集成范式（见 tests/ws/*.test.ts），
 * 不另造 deps 注入层——既贴合全仓现有测试写法，也更克制。
 */
import type { ClientRequestPayload } from '@shared/protocol';
import type { Broadcast, Reply } from '../server';

/** 每个 handler 拿到的统一上下文。reply/broadcast 沿用 server.ts 的真实签名，迁移即纯搬运。 */
export type CommandCtx = {
  reply: Reply;
  broadcast: Broadcast;
};

/**
 * Handler 与 req.type 绑定：靠 discriminated union 自动把 req 窄化成该 type 的具体形态。
 * req 形态 = 协议联合里该 type 的成员 + reqId（运行期传入的是完整 ClientRequest）。
 */
export type CommandHandler<T extends ClientRequestPayload['type']> = (
  req: Extract<ClientRequestPayload, { type: T }> & { reqId: string },
  ctx: CommandCtx,
) => Promise<void> | void;

/** 完整注册表：键的类型 = 协议联合的所有 type，缺一个 key 编译期报错（穷尽性）。index.ts 用它做合并点约束。 */
export type CommandRegistry = {
  [T in ClientRequestPayload['type']]: CommandHandler<T>;
};

/**
 * 单个域文件导出的注册表切片（= `Partial<CommandRegistry>`）。一个域只覆盖自己那几个命令，
 * 故用 Partial；穷尽性不在这里、而在 index.ts 把所有切片合成完整 `CommandRegistry` 时强制。
 */
export type RegistrySlice = Partial<CommandRegistry>;
