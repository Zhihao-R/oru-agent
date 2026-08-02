/**
 * AI 主体的显示名解析——称呼收敛的单一源（见 PRD《AI 主体怎么称呼》三层命名体系）。
 *
 * - 物种名 Oru：无个体名时的回落，中英界面都叫 Oru、不翻。
 * - 个体名：用户给某个 Oru 起的 name；界面所有第三人称提及优先用它。
 *
 * 界面文案里凡第三人称提及主体（「跟 {name} 说点什么」「等 {name} 答中…」），
 * 都把这里解析出的名字作为 {{name}} 插值传入——不再硬编码「分身」/「Twin」。
 * 内部代码标识符 twin 不在收敛之列，保持不动。
 *
 * 取哪个 agent 的 name（多实例 + 历史消息场景的约定）：
 * - 绑定具体上下文的提及（某条历史消息、某个 agent 行）→ 传**该上下文** agent 的 name，
 *   不要一律用当前 active（否则会把别的 agent 说的话标成当前 Oru）。
 * - 无上下文歧义的界面 chrome（顶栏 chip、空状态）→ 用当前 active 的 name。
 * - 任何 agent 都拿不到时 → 回落 Oru（resolveOruName 传 undefined 即可）。
 */
import { useAgentStore } from '@/stores/agentStore';

export const ORU_SPECIES_NAME = 'Oru';

/** 个体名优先，空/纯空白/未设回落物种名 Oru。纯函数、agent-agnostic：调用方决定传哪个 agent 的 name。 */
export function resolveOruName(name?: string | null): string {
  return name?.trim() || ORU_SPECIES_NAME;
}

/** React：当前活跃 Oru 的显示名（个体名 || Oru）——用于无上下文歧义的界面 chrome（顶栏/手账入口等）。 */
export function useOruName(): string {
  return useAgentStore((s) => resolveOruName(s.agents.find((a) => a.id === s.activeAgentId)?.name));
}
