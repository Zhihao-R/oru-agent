/**
 * 评论场景的 system prompt 拼装。
 *
 * 拆两段：
 *   - stable：跨 task 不变的行为规则——拼到 stableSystemContext 段，**保证 prompt cache 命中**
 *   - dynamic：当前 task 字段快照——拼到 dynamic 段，每次 task 字段变会让这部分变
 *
 * 不变量：stable 段不能含 task 字段——否则不同 task 跑评论时 prompt cache 失效。
 * smoke 验证：同一 task 多次调 / 不同 task 调，stable 字符串始终相同。
 */
import type { BoardTask } from '@shared/types';
import { STABLE as STABLE_RAW } from '../prompts/taskboardStable';

const STABLE = STABLE_RAW.trim();

export function buildCommentPrompt(opts: { task: BoardTask }): { stable: string; dynamic: string } {
  const t = opts.task;
  const dynamic = [
    '当前任务：',
    `- 标题：${t.title}`,
    `- 状态：${t.status}`,
    `- 归属：${t.assignee}`,
    `- 项目 tag：${t.projectTag ?? '无'}`,
    `- 描述：${t.description ?? '(无)'}`,
  ].join('\n');
  return { stable: STABLE, dynamic };
}
