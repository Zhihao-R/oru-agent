/**
 * 制品版本历史 AI 工具：list / checkout
 *
 * 只在主分身（twinMain + twinSubagent）注册——版本切换是用户级决策，subagent 不应自己跳版本。
 *
 * activeArtifactId 由 deck/store.ts 维护的进程内单例提供；工具不依赖 ToolContext.activeArtifactId
 * （避免污染 ToolContext schema——只有 2 个工具用得到的字段不值得加到全局上下文）。
 */
import type { AgentTool } from '@shared/agent/backend';
import { getActiveDeckId, getDeck } from '../../deck/store';
import { listVersions, readManifest, checkoutVersion, isDirty, commitVersion } from '../../deck/history';
import { flushPending } from '../../deck/commitScheduler';

export function makeArtifactHistoryListTool(): AgentTool {
  return {
    name: 'artifact_history_list',
    mutatesEnvironment: false,
    description:
      '列出当前激活制品（artifact）的版本历史（时间倒序）。' +
      '用于回应"我之前是怎么改的？" / "回到上一版"等问题。没有激活制品时返回错误。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute(_input, _ctx) {
      const artifactId = getActiveDeckId();
      if (!artifactId) return { isError: true, text: '当前没有激活的制品' };
      const deck = await getDeck(artifactId);
      if (!deck) return { isError: true, text: `active artifactId ${artifactId} 找不到对应记录` };
      const manifest = await readManifest(artifactId);
      const versions = await listVersions(artifactId);
      if (versions.length === 0) return { text: `${deck.name}：无版本历史` };
      const sorted = [...versions].sort((a, b) => b.createdAt - a.createdAt);
      const lines = sorted.map((v) => {
        const pages = v.changedPages.length > 0 ? `改了第 ${v.changedPages.map((p) => p + 1).join(', ')} 页` : '——';
        const current = manifest?.currentVersion === v.id ? ' [当前]' : '';
        return `- ${v.id}${current} · ${new Date(v.createdAt).toISOString().slice(0, 19).replace('T', ' ')} · ${v.kind} · ${v.summary} · ${pages}`;
      });
      return { text: `${deck.name} 的版本历史：\n${lines.join('\n')}` };
    },
  };
}

export function makeArtifactHistoryCheckoutTool(): AgentTool {
  return {
    name: 'artifact_history_checkout',
    mutatesEnvironment: true,
    description:
      '切回当前激活制品（artifact）的某个历史版本作为新起点。' +
      '会先自动 commit 当前未提交改动（不会丢工作），然后清空 undo 栈（避免跨版本撤销到不存在状态）。' +
      '若版本引用的图片被删除会返回错误清单，请告知用户确认后用 force=true 重新调用。',
    inputSchema: {
      type: 'object',
      properties: {
        version_id: { type: 'string', description: '版本 id，如 "v002"' },
        force: { type: 'boolean', description: '为 true 时即使有 missingImages 也强制切换' },
      },
      required: ['version_id'],
    },
    async execute(input, _ctx) {
      const args = input as { version_id: string; force?: boolean };
      const artifactId = getActiveDeckId();
      if (!artifactId) return { isError: true, text: '当前没有激活的制品' };

      try {
        // 防护性 commit：切版本前如果 dirty 先落一版
        await flushPending(artifactId);
        if (await isDirty(artifactId)) {
          await commitVersion(artifactId, 'protective', '切到旧版本前的暂存');
        }

        const r = await checkoutVersion(artifactId, args.version_id, { force: args.force });
        if (!r.ok) {
          return {
            isError: true,
            text:
              `切版本失败 — 版本 ${args.version_id} 引用的以下图片不存在：\n` +
              r.missingImages.map((m) => `- ${m}`).join('\n') +
              '\n\n如用户确认继续，请用 force: true 重试。',
          };
        }
        // checkoutVersion 内部已清 undo stack（详 tech doc §7.6）
        return { text: `已切到版本 ${args.version_id}。Undo 栈已清空——更早改动需通过历史面板恢复。` };
      } catch (e) {
        const err = e as Error & { code?: string };
        // 版本不存在等已知错误 → isError text；底层 throw 转友好提示
        return { isError: true, text: `切版本失败：${err.message}` };
      }
    },
  };
}
