import type { ClientRequest } from '@shared/protocol';
import type { Broadcast, Reply } from './server';
import { registry } from './handlers';
import { ErrorCodes } from '@shared/types';
import { errCode, errMsg } from './errors';

// turn 编排已按内聚度拆进 handlers/{turnArgs,resumeTurn,brake,convState,systemActionConversation}.ts；
// proposal 注册表下沉到 proposals/registry.ts（2026-07-22 盘点 M6：修依赖倒置——原本住在传输层，
// 逼得下层服务反向 `await import('../ws/router')` 够上来取）。各调用方现直接 import 真源，router 不再当转发垫片。
export { enqueueTaskCompletionAnnounce } from './handlers/taskCompletionAnnounce';

/**
 * WS 命令分发入口（D2(a)）：按 req.type 在注册表查 handler 执行，业务按域拆在 handlers/<域>.ts。
 * registry 是完整 CommandRegistry——mapped type `{ [T in ClientRequestPayload['type']]: ... }`
 * 强制穷尽：漏接一个协议命令编译期即报错（取代了原 167-case switch 的人肉纪律）。
 */
export async function route(
  req: ClientRequest,
  reply: Reply,
  broadcast: Broadcast,
): Promise<void> {
  try {
    const handler = registry[req.type];
    if (!handler) {
      // 协议外的 req.type（版本错配 / 脏数据）才会走到这——运行期兜底，非编译期可达分支。
      const unknown = req as { reqId: string; type: string };
      reply(unknown.reqId, {
        type: 'error',
        code: ErrorCodes.UNKNOWN,
        message: `unknown request type: ${unknown.type}`,
      });
      return;
    }
    // registry 各 handler 的 req 类型由定义端 `satisfies` 保证；此处联合索引使参数逆变成 never，故 as never。
    await handler(req as never, { reply, broadcast });
  } catch (e) {
    reply((req as { reqId: string }).reqId, {
      type: 'error',
      code: errCode(e),
      message: errMsg(e),
    });
  }
}
