/**
 * generate_deck AgentTool —— 事后生成 deck。
 *
 * 配套创建流改造：propose_deck_create 带 auto_generate=false 时只建壳 + 写叙事文稿、不生成。
 * 用户过目/改完文稿后，本工具触发 subagent 按 .narrative.md + deck skill 把 deck 铺满。
 *
 * 缺省锚定 active deck（创建链路建壳后已 setActiveDeckId），与 artifact_history_* 一致——
 * 不依赖 ToolContext.activeArtifactId，由 deck/store 进程内单例提供。
 * deckSkillId 从 deck 记录复用（创建时持久化）；广播走 ws/server 的全局 broadcast。
 */
import type { AgentTool } from '@shared/agent/backend';
import { getActiveDeckId, getDeck } from '../../deck/store';
import { generateDeckForArtifact } from '../../deck/dispatchSubagent';

export function makeGenerateDeckTool(): AgentTool {
  return {
    name: 'generate_deck',
    mutatesEnvironment: true,
    description:
      '按 deck 当前的叙事文稿（.narrative.md）生成/重生成 HTML。' +
      '用于 propose_deck_create 走"先过目文稿"路径（auto_generate=false）建壳后、用户改完文稿要正式生成时调用。' +
      'artifact_id 缺省取当前激活的 deck。没有激活 deck 时返回错误。',
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: {
          type: 'string',
          description: '目标 deck 的 artifactId；缺省取当前激活的 deck。',
        },
      },
      required: [],
    },
    async execute(input, ctx) {
      const args = input as { artifact_id?: string };
      const artifactId = args.artifact_id ?? getActiveDeckId();
      if (!artifactId) return { isError: true, text: '当前没有激活的 deck，请先指定 artifact_id。' };
      const deck = await getDeck(artifactId);
      if (!deck) return { isError: true, text: `deck 找不到：${artifactId}` };

      const { broadcast } = await import('../../ws/server');
      const r = await generateDeckForArtifact({
        deck,
        conversationId: ctx.conversationId,
        broadcast,
      });
      if (!r.ok) return { isError: true, text: `派生成任务失败：${r.message}` };
      return { text: `已按叙事文稿派 subagent 生成「${deck.name}」，生成完成后预览会自动刷新。` };
    },
  };
}
