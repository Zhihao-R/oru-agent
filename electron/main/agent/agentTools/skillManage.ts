/**
 * Skill 模块（v1 加分项）：skill_manage 工具——让分身把工作流存为 skill / 小修已有 skill。
 *
 * 触发条件（写在 tool description 里，比塞 system prompt 触发率更高）：
 * - 用户明确要求"把这个流程存下来" / "把刚才那个流程改改"
 * - 完成一个跨 5+ tool call 的复杂任务后（适合存为 skill 给下次复用）
 * - 修了一个反直觉的奇怪 bug 后（patch 已有相关 skill）
 * - 分身发现某 plugin 激活描述写得不准导致触发不准时（patch plugin-manifest 的 activationDescription）
 *
 * unique 校验（patch）：oldString 在目标文件必须唯一出现——0 或 >1 直接 isError，不进 proposal queue。
 *
 * 写完 skill 的回声防护：当前对话不可见，下次对话才加载——避免分身刚写完就被自己写的 skill 影响判断。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AgentTool } from '@shared/agent/backend';
import {
  buildSkillCreateProposal,
  buildSkillPatchProposal,
} from '../../proposals/makePluginProposal';
import { countOccurrences, buildDiffPreview, extractSkillDescription } from '../../skills/manager';
import { proposeOrExecuteEnvChange } from './emitProposal';
import { pluginDir, skillDir } from '../../runtime/paths';

/** 写完 skill 的回声防护说明——两个 action 的回执尾巴一致（本对话内看不见，下次对话才生效）。 */
const ECHO_GUARD_NOTE = '当前对话内还看不见它（回声防护），下次对话才生效。';

export function makeSkillManageTool(): AgentTool {
  return {
    name: 'skill_manage',
    mutatesEnvironment: true,
    description:
      [
        '管理 skill（v1 加分项）。两种 action：',
        '- create: 把当前对话里跑通的工作流存为新 skill。',
        '  传 name + skillMd（完整 SKILL.md，含 frontmatter）。',
        '  触发条件：用户说"把这个存下来" / 完成 5+ tool call 的复杂任务 / 修了奇怪 bug。',
        '  调前先 read_skill("writing-oru-skills") 拿到怎么写 skill 的元指引。',
        '- patch: 对已有 skill / plugin 激活描述做 find-and-replace 小修。',
        '  target=skill 改 SKILL.md；target=plugin-manifest 改 .oru-plugin.json 的 activationDescription。',
        '  oldString 必须在目标文件唯一出现（同 Edit 工具约束）。',
        '  触发条件：plugin 激活描述写得不准 / skill 里某段过时。',
        '',
        '落盘前不会返回——回执里是真实成败。新建/修改后当前对话内看不见它（回声防护），下次对话才生效。',
      ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'patch'] },
        target: {
          type: 'string',
          enum: ['skill', 'plugin-manifest'],
          description: 'patch 时必传。create 时固定 skill（plugin-manifest 不能 create）',
        },
        name: {
          type: 'string',
          description:
            'create 时 = 新 skill folder name（kebab-case）；patch 时 = 目标 skill name 或 pluginId',
        },
        create: {
          type: 'object',
          description: 'action=create 时必传',
          properties: {
            skillMd: { type: 'string', description: '完整 SKILL.md（含 frontmatter name + description + body）' },
            scripts: {
              type: 'array',
              description: '可选 scripts/* 内容',
              items: {
                type: 'object',
                properties: {
                  relPath: { type: 'string' },
                  content: { type: 'string' },
                },
                required: ['relPath', 'content'],
              },
            },
          },
          required: ['skillMd'],
        },
        patch: {
          type: 'object',
          description: 'action=patch 时必传',
          properties: {
            oldString: { type: 'string' },
            newString: { type: 'string' },
          },
          required: ['oldString', 'newString'],
        },
      },
      required: ['action', 'name'],
    },
    async execute(input, ctx) {
      const args = input as {
        action: 'create' | 'patch';
        target?: 'skill' | 'plugin-manifest';
        name: string;
        create?: { skillMd: string; scripts?: Array<{ relPath: string; content: string }> };
        patch?: { oldString: string; newString: string };
      };

      if (args.action === 'create') {
        if (args.target && args.target !== 'skill') {
          return { isError: true, text: 'create 仅支持 target=skill（plugin-manifest 不能 create）' };
        }
        if (!args.create?.skillMd) {
          return { isError: true, text: 'create 需要 create.skillMd' };
        }
        const desc = extractSkillDescription(args.create.skillMd);
        if (!desc) {
          return {
            isError: true,
            text: 'SKILL.md frontmatter 缺 description——这是触发判断的关键字段，必须填',
          };
        }
        try {
          const proposal = buildSkillCreateProposal({
            conversationId: ctx.conversationId,
            title: `新建 skill ${args.name}`,
            description: `把当前对话的工作流存为 skill ${args.name}`,
            skillName: args.name,
            skillDescription: desc,
            skillMd: args.create.skillMd,
            scripts: args.create.scripts,
          });
          return await proposeOrExecuteEnvChange(ctx, proposal, {
            approvalText: `当前环境没有可确认的界面，未新建 skill ${args.name}。`,
            perform: async () => {
              const { performSkillCreate } = await import('../../skills/manager');
              const r = await performSkillCreate(proposal);
              return { text: `skill ${r.name} 已建好并落盘。${ECHO_GUARD_NOTE}`, outcome: { ok: true, name: r.name } };
            },
          });
        } catch (e) {
          return { isError: true, text: `新建 skill 失败：${(e as Error).message}` };
        }
      }

      // patch
      const target = args.target ?? 'skill';
      if (!args.patch?.oldString || args.patch.newString === undefined) {
        return { isError: true, text: 'patch 需要 patch.oldString + patch.newString' };
      }

      // unique 校验：直接读目标文件
      let targetPath: string;
      if (target === 'skill') {
        targetPath = join(skillDir(args.name), 'SKILL.md');
      } else {
        targetPath = join(pluginDir(args.name), '.oru-plugin.json');
      }
      let text: string;
      try {
        text = await fs.readFile(targetPath, 'utf-8');
      } catch (e) {
        return { isError: true, text: `读取目标文件失败：${(e as Error).message}` };
      }
      const count = countOccurrences(text, args.patch.oldString);
      if (count === 0) {
        return { isError: true, text: 'oldString 在目标文件中未找到——重新读 read_skill 看下当前文本' };
      }
      if (count > 1) {
        return {
          isError: true,
          text: `oldString 在目标文件中出现 ${count} 次，不唯一——加更多上下文让 oldString 唯一定位`,
        };
      }

      // 计算 patch 后的 description（仅 target=plugin-manifest 有意义；skill 时用原 frontmatter）
      const targetDescription =
        target === 'plugin-manifest'
          ? extractActivationDescriptionFromManifest(text, args.patch.oldString, args.patch.newString)
          : extractSkillDescription(text);

      try {
        const proposal = buildSkillPatchProposal({
          conversationId: ctx.conversationId,
          title: `修改 ${target === 'skill' ? 'skill' : 'plugin'} ${args.name}`,
          description: `find-and-replace 修改 ${args.name}`,
          target,
          name: args.name,
          oldString: args.patch.oldString,
          newString: args.patch.newString,
          diffPreview: buildDiffPreview(text, args.patch.oldString, args.patch.newString),
          targetDescription,
        });
        return await proposeOrExecuteEnvChange(ctx, proposal, {
          approvalText: `当前环境没有可确认的界面，未修改 ${args.name}。`,
          perform: async () => {
            const { performSkillPatch } = await import('../../skills/manager');
            const r = await performSkillPatch(proposal);
            return { text: `${r.name} 已改好并落盘。${ECHO_GUARD_NOTE}`, outcome: { ok: true, name: r.name } };
          },
        });
      } catch (e) {
        return { isError: true, text: `修改 ${args.name} 失败：${(e as Error).message}` };
      }
    },
  };
}

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
