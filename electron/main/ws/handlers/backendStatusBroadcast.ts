/**
 * providers / models / modelAssignments 变更后，推送最新的主对话后端可用性（auth.status）。
 *
 * 闭环：UI 门禁（输入禁用 / 顶栏徽章）只听 auth.status，而这些配置走专用命令、不经
 * settings.update——不推的话，用户按提示配好模型后徽章仍挂到重启才消。
 */
import type { Broadcast } from '../server';
import { mainChatStatus } from '../../agent/backends/readiness';

export async function broadcastMainChatStatus(broadcast: Broadcast): Promise<void> {
  broadcast({ type: 'auth.status', status: await mainChatStatus() });
}
