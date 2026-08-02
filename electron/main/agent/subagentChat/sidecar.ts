/**
 * 对话期 subagent 内部对话 sidecar IO（jsonl 格式）。
 *
 * 为什么 sidecar 而非内嵌主对话 ChatMessage：
 * 主 agent 的 historyAdapter 读 ChatMessage 喂给 LLM 是无差别处理的；若把 subagent
 * 完整 innerMessages 挂在主对话 ChatMessage.subagent 里，下一轮主对话上下文会
 * 无端膨胀几十 KB。sidecar 让"前端按需加载"和"LLM 上下文"物理隔离——
 * 主对话 ChatMessage 只持 chip 摘要，subagent 完整对话另存一个 jsonl。
 *
 * 为什么 jsonl 而非 JSON array：跟现有 conversations/store.ts 一致；append 写到一半
 * crash 时，已写完的行仍可被 readSidecar 解析，未完成行被跳过——比 JSON array 安全。
 *
 * 并发：append 不用全局 writeQueue（会让所有 subagent sidecar 串行）。runSubagent
 * 内部对单个 sidecar 文件的写是顺序的（for-await 同步等 append 返回），不同 taskId
 * 写不同文件互不冲突——v1 不存在"同一文件多个并发写"的场景，因此不需要锁。
 * 目录创建由 runSubagent 在启动时一次性完成，append 不再 mkdir。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import type { ChatMessage } from '@shared/types';
import {
  conversationSubagentsDir,
  subagentSidecarFile,
} from '../../runtime/paths';

/** 启动 subagent 前调一次，确保 sidecar 目录存在；后续 append 不再 mkdir */
export async function ensureSidecarDir(
  ownerId: string,
  agentId: string,
  convId: string,
): Promise<void> {
  await fs.mkdir(conversationSubagentsDir(ownerId, agentId, convId), { recursive: true });
}

/** Append 一条 subagent 内部消息到 sidecar.jsonl（调用方保证目录已存在） */
export async function appendSidecarMessage(
  ownerId: string,
  agentId: string,
  convId: string,
  taskId: string,
  msg: ChatMessage,
): Promise<void> {
  const file = subagentSidecarFile(ownerId, agentId, convId, taskId);
  await fs.appendFile(file, JSON.stringify(msg) + '\n', 'utf-8');
}

/**
 * 读 sidecar.jsonl；文件不存在或全部损坏时返回空数组（不抛错）。
 * 非 ENOENT 的 IO 错（权限 / EIO 等）会记录并返回空数组——前端拿到空数组而非 IPC 失败。
 */
export async function readSidecar(
  ownerId: string,
  agentId: string,
  convId: string,
  taskId: string,
): Promise<ChatMessage[]> {
  const file = subagentSidecarFile(ownerId, agentId, convId, taskId);
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (e) {
    console.warn(`[readSidecar] IO error reading ${file}:`, e);
    return [];
  }
  const out: ChatMessage[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Partial<ChatMessage>;
      if (typeof obj.id === 'string' && typeof obj.role === 'string') {
        if (typeof obj.text !== 'string') obj.text = '';
        out.push(obj as ChatMessage);
      }
    } catch {
      // 损坏行跳过——append 写到一半 crash 时常见
    }
  }
  return out;
}
