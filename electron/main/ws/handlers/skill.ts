/**
 * skill.* 命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内 skill.* 各 case 字节级一致——纯搬运。
 * 注：handler 比 router 深一层目录，相对动态 import 路径相应多一层 `../`。
 * extractActivationDescriptionFromManifest 仅 skill.patch 用，随域搬来作本地函数（不导出）。
 */
import type { RegistrySlice } from './types';
import { rememberProposal } from '../../proposals/registry';
import { resolveActiveConversationId } from './systemActionConversation';

/**
 * Skill 模块 v1：从 `.oru-plugin.json` 应用 patch 后的文本解析 activationDescription，
 * 用于 skill.patch (target='plugin-manifest') 卡上展示 targetDescription。
 * 解析失败返回空串——卡上仍展示，不阻断流程。
 */
function extractActivationDescriptionFromManifest(
  originalText: string,
  oldString: string,
  newString: string,
): string {
  try {
    const patched = originalText.replace(oldString, newString);
    const parsed = JSON.parse(patched);
    return typeof parsed.activationDescription === 'string'
      ? parsed.activationDescription
      : '';
  } catch {
    return '';
  }
}

export const skillHandlers = {
  'skill.list': async (req, { reply, broadcast }) => {
    const { listStandaloneSkills, reconcileSkillRegistry } = await import('../../skills/registry');
    const { listPlugins } = await import('../../plugins/registry');
    // 面板打开即对账磁盘——兜底 watcher 漏掉的外部改动（尤其 Linux 无 recursive watch）。
    // 有增删则广播，让其它已连客户端同步。
    try {
      const { added, removed } = await reconcileSkillRegistry();
      if (added.length > 0 || removed.length > 0) {
        const { broadcastSkillsState } = await import('../../skills/chipWriter');
        await broadcastSkillsState(broadcast);
      }
    } catch (e) {
      console.warn('[oru.skills] skill.list 对账失败（返回内存态）:', e);
    }
    // 合并独立装 + 内置 + plugin 内的所有 skill，让 UI 一处看完
    const out = [
      ...listStandaloneSkills(),
      ...listPlugins().flatMap((p) => p.skills),
    ];
    reply(req.reqId, { type: 'skill.list.result', skills: out });
  },
  'skill.get': async (req, { reply }) => {
    const { getSkill } = await import('../../skills/registry');
    const { getPlugin } = await import('../../plugins/registry');
    const { promises: fs } = await import('node:fs');
    const { join } = await import('node:path');
    let skill = getSkill(req.skillId);
    if (!skill) {
      // 尝试 plugin 内 skill
      const colon = req.skillId.indexOf(':');
      if (colon > 0) {
        const plugin = getPlugin(req.skillId.slice(0, colon));
        skill = plugin?.skills.find((s) => s.id === req.skillId);
      }
    }
    if (!skill) {
      reply(req.reqId, { type: 'skill.get.result', skill: null });
      return;
    }
    try {
      const skillMd = await fs.readFile(join(skill.path, 'SKILL.md'), 'utf-8');
      reply(req.reqId, { type: 'skill.get.result', skill, skillMd });
    } catch {
      reply(req.reqId, { type: 'skill.get.result', skill });
    }
  },
  'skill.create': async (req, { reply, broadcast }) => {
    try {
      const { buildSkillCreateProposal } = await import('../../proposals/makePluginProposal');
      const { extractSkillDescription } = await import('../../skills/manager');
      const desc = extractSkillDescription(req.skillMd);
      if (!desc) {
        reply(req.reqId, {
          type: 'skill.action.result',
          ok: false,
          message: 'SKILL.md frontmatter 缺 description——这是触发关键字段，必须填',
        });
        return;
      }
      const conv = req.conversationId ?? await resolveActiveConversationId(broadcast, '新建技能');
      const proposal = buildSkillCreateProposal({
        conversationId: conv,
        title: `新建 skill ${req.name}`,
        description: `把工作流存为 skill ${req.name}`,
        skillName: req.name,
        skillDescription: desc,
        skillMd: req.skillMd,
        scripts: req.scripts,
      });
      rememberProposal(proposal);
      broadcast({ type: 'chat.proposal', conversationId: conv, proposal });
      reply(req.reqId, { type: 'skill.action.result', ok: true, proposalId: proposal.id });
    } catch (e) {
      reply(req.reqId, { type: 'skill.action.result', ok: false, message: (e as Error).message });
    }
  },
  'skill.patch': async (req, { reply, broadcast }) => {
    try {
      const { buildSkillPatchProposal } = await import('../../proposals/makePluginProposal');
      const { countOccurrences, buildDiffPreview, extractSkillDescription } = await import('../../skills/manager');
      const { skillDir, pluginDir } = await import('../../runtime/paths');
      const { join } = await import('node:path');
      const { promises: fs } = await import('node:fs');
      const targetPath =
        req.target === 'skill'
          ? join(skillDir(req.name), 'SKILL.md')
          : join(pluginDir(req.name), '.oru-plugin.json');
      let text: string;
      try {
        text = await fs.readFile(targetPath, 'utf-8');
      } catch (e) {
        reply(req.reqId, { type: 'skill.action.result', ok: false, message: `读取目标文件失败: ${(e as Error).message}` });
        return;
      }
      const count = countOccurrences(text, req.oldString);
      if (count === 0) {
        reply(req.reqId, { type: 'skill.action.result', ok: false, message: 'oldString 在目标文件中未找到' });
        return;
      }
      if (count > 1) {
        reply(req.reqId, { type: 'skill.action.result', ok: false, message: `oldString 在目标文件中出现 ${count} 次，不唯一` });
        return;
      }
      const conv = req.conversationId ?? await resolveActiveConversationId(broadcast, '改技能');
      const targetDesc =
        req.target === 'plugin-manifest'
          ? extractActivationDescriptionFromManifest(text, req.oldString, req.newString)
          : extractSkillDescription(text);
      const proposal = buildSkillPatchProposal({
        conversationId: conv,
        title: `修改 ${req.target === 'skill' ? 'skill' : 'plugin'} ${req.name}`,
        description: `find-and-replace 修改 ${req.name}`,
        target: req.target,
        name: req.name,
        oldString: req.oldString,
        newString: req.newString,
        diffPreview: buildDiffPreview(text, req.oldString, req.newString),
        targetDescription: targetDesc,
      });
      rememberProposal(proposal);
      broadcast({ type: 'chat.proposal', conversationId: conv, proposal });
      reply(req.reqId, { type: 'skill.action.result', ok: true, proposalId: proposal.id });
    } catch (e) {
      reply(req.reqId, { type: 'skill.action.result', ok: false, message: (e as Error).message });
    }
  },
  'skill.setEnabled': async (req, { reply, broadcast }) => {
    try {
      const { setSkillEnabled } = await import('../../skills/registry');
      const { broadcastSkillsState } = await import('../../skills/chipWriter');
      const res = await setSkillEnabled(req.skillId, req.enabled);
      if (res === 'ok') {
        reply(req.reqId, { type: 'skill.setEnabled.result', ok: true });
        await broadcastSkillsState(broadcast);
      } else if (res === 'notFound') {
        reply(req.reqId, {
          type: 'skill.setEnabled.result',
          ok: false,
          message: `skill 不存在: ${req.skillId}`,
        });
      } else {
        reply(req.reqId, {
          type: 'skill.setEnabled.result',
          ok: false,
          message: 'plugin 内 skill 跟随父 plugin 启停——请在 plugin 行切换',
        });
      }
    } catch (e) {
      reply(req.reqId, {
        type: 'skill.setEnabled.result',
        ok: false,
        message: (e as Error).message,
      });
    }
  },
  'skill.delete': async (req, { reply, broadcast }) => {
    try {
      const { getSkill, removeSkillFromRegistry } = await import('../../skills/registry');
      const { broadcastSkillsState } = await import('../../skills/chipWriter');
      const skill = getSkill(req.skillId);
      if (!skill) {
        reply(req.reqId, { type: 'skill.delete.result', ok: false, message: `skill 不存在: ${req.skillId}` });
        return;
      }
      if (skill.source === 'builtin') {
        reply(req.reqId, { type: 'skill.delete.result', ok: false, message: '内置 skill 不可删（可在拓展页改写但不能删）' });
        return;
      }
      if (skill.source === 'plugin') {
        reply(req.reqId, { type: 'skill.delete.result', ok: false, message: 'plugin 内 skill 跟随 plugin 卸载——请卸 plugin' });
        return;
      }
      const { promises: fs } = await import('node:fs');
      await fs.rm(skill.path, { recursive: true, force: true });
      removeSkillFromRegistry(req.skillId);
      reply(req.reqId, { type: 'skill.delete.result', ok: true });
      await broadcastSkillsState(broadcast);
    } catch (e) {
      reply(req.reqId, { type: 'skill.delete.result', ok: false, message: (e as Error).message });
    }
  },
} satisfies RegistrySlice;
