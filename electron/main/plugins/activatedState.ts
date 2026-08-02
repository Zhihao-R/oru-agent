/**
 * Skill 模块（v1）：从 conversation chat 流重建 activatedPlugins Set。
 *
 * 设计原则（见 docs/tech/2026-05-24-skill-module-tech-design.md L233-248）：
 * 不在 Conversation 类型里加 activatedPlugins 字段——避免元数据膨胀，
 * 每轮 runner 拼 ToolContext 时扫一次历史即可。
 *
 * 扫描输入是 readHistoryForLLM 返回的切片（即 compress 后的 workingHistory），
 * 跨 context-compressed 的激活态依赖 plugin-activate chip 在 NEVER_COMPRESS_KINDS 白名单内存活。
 *
 * 性能：O(N) 遍历，N 一般 < 100 毫秒级；超长 conversation（> 5000 轮）可加缓存（v2）。
 */
import type { ChatMessage } from '@shared/types';

export function rebuildActivatedPlugins(history: ChatMessage[]): Set<string> {
  const out = new Set<string>();
  for (const msg of history) {
    if (msg.kind === 'plugin-activate' && msg.skillModuleAction?.id) {
      // 激活失败的 chip 不计入（errorMessage 非空）
      if (!msg.skillModuleAction.errorMessage) {
        out.add(msg.skillModuleAction.id);
      }
    }
  }
  return out;
}
