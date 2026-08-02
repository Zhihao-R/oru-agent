/**
 * propose_deck_create AgentTool
 *
 * 主分身澄清完用户的 deck 需求后调用——建 deck 壳（autoGenerate 时连带派出生成 subagent）。
 * 走 proposeOrExecuteEnvChange：免审批直接建、需审批则挂起等确认，真实成败在原轮回给模型。
 *
 * 与 propose_action（kind: 'code'）的区别：
 * - propose_action 用于代码改动（任意项目内文件）
 * - propose_deck_create 专用于新建 deck——卡片字段 / 执行链路差异显著，详 tech doc §9.3 / §13.5
 */
import type { AgentTool } from '@shared/agent/backend';
import { buildDeckCreateProposal } from '../../proposals/makeDeckProposal';
import { buildSkillInstallProposal } from '../../proposals/makePluginProposal';
import { proposeOrExecuteEnvChange } from './emitProposal';
import { DEFAULT_DECK_SKILL_ID, findCuratedDeckSkill } from '../../deck/deckSkillCatalog';

/** deck skill 是否已注册（standalone 或 plugin 内）——决定走不走引导安装卡。 */
async function isDeckSkillInstalled(skillId: string): Promise<boolean> {
  const { getSkill } = await import('../../skills/registry');
  if (getSkill(skillId)) return true;
  if (skillId.includes(':')) {
    const { getPlugin } = await import('../../plugins/registry');
    const plugin = getPlugin(skillId.slice(0, skillId.indexOf(':')));
    return !!plugin?.skills.some((s) => s.id === skillId);
  }
  return false;
}

export function makeProposeDeckCreateTool(): AgentTool {
  return {
    name: 'propose_deck_create',
    mutatesEnvironment: false,
    description:
      '当用户已经澄清了想做的 deck（风格、受众、规模、主题、是否含图等）准备进入生成阶段时调用，' +
      '建一份新 deck（壳 + 叙事文稿；需要用户过目时会先弹卡等确认）。建好前不会返回——回执里是真实成败。' +
      '澄清阶段（用户还没明确风格 / 受众等）不要调此工具——继续在聊天里问。' +
      'deck_skill_id 缺省时由系统选用户已装载的 deck 生成 skill；若用户明确指了某个，按用户指定填入。\n' +
      '调用前你必须先起草好 narrative（叙事文稿全文）——讲清这份 deck 要讲什么、怎么递进、每段核心，' +
      '它会写进 deck 供生成时遵循、也供用户过目修改。\n' +
      'auto_generate 控制起草后是否直接生成，按用户的过目偏好定（三分支）：\n' +
      '- 用户明确要"直接生成、别停下让我看"（且你已 record_memory 记下这条偏好）→ true，建壳后立即派 subagent 生成；\n' +
      '- 用户明确要"每次先给我过目文稿" → 始终 false，建壳即停，用户改完文稿再触发生成；\n' +
      '- 记忆里查不到用户的过目偏好（≈第一次用这功能）→ 默认 false：建壳后停一下，告诉用户' +
      '"叙事文稿已放进「文稿」标签，过目/编辑满意后点「从文稿生成演示设计」（或直接说『生成吧』）；' +
      '以后想跳过这步直接生成，说一声即可"——让新用户第一次就看见"叙事先行"。',
    inputSchema: {
      type: 'object',
      properties: {
        deck_name: {
          type: 'string',
          description:
            '用户层显示名，也是 deck 目录名。可含中文 / 空格；非法文件名字符 ( / \\ : * ? " < > | ) 会被自动替换为 -。重名加 -2 后缀。',
        },
        target_project_id: {
          type: ['string', 'null'],
          description: '目标项目 id；null 用 active 项目。没有 active 项目时此工具会返回错误。',
        },
        deck_skill_id: {
          type: 'string',
          description: '生成用的 deck skill id。可在 SKILL.md frontmatter 标 category=deck 的 skill 里挑——用户没指定时本工具按默认 fallback 填入。',
        },
        brief: {
          type: 'string',
          description:
            '一段话讲清要做什么 deck——风格 / 受众 / 页数 / 主题 / 是否含图。这段会作为 propose 卡的 description 给用户看，也作为 subagent 的种子 prompt。',
        },
        size_hint: {
          type: 'string',
          description: '页数 + 图数预估，如"≈ 12 页 · 8 张图"——propose 卡显示',
        },
        eta_hint: {
          type: 'string',
          description: '预估时长，如"5 分钟"——propose 卡显示',
        },
        narrative: {
          type: 'string',
          description:
            '你起草的叙事文稿全文（markdown）——这份 deck 要讲什么、怎么递进、每段核心。' +
            '会写进 deck 的 .narrative.md 作为生成依据，也供用户过目修改。',
        },
        auto_generate: {
          type: 'boolean',
          description:
            '起草后是否直接生成。false=建壳即停（让用户先过目改文稿）；true=建壳后立即派 subagent 生成。' +
            '缺省按 false 处理（先过目更稳）。',
        },
      },
      required: ['deck_name', 'brief', 'size_hint', 'narrative'],
    },
    async execute(input, ctx) {
      const args = input as {
        deck_name: string;
        target_project_id?: string | null;
        deck_skill_id?: string;
        brief: string;
        size_hint: string;
        eta_hint?: string;
        narrative: string;
        auto_generate?: boolean;
      };
      // inputSchema required 校验——backend 不保证运行时校验，空 {} 会一路穿透到 sanitizeDeckName 崩溃
      const missing = (['deck_name', 'brief', 'size_hint', 'narrative'] as const).filter(
        (k) => typeof args[k] !== 'string' || !args[k],
      );
      if (missing.length) {
        return {
          isError: true,
          text: `Missing required parameters: ${missing.join(', ')}. These are required by inputSchema.`,
        };
      }
      // active 项目 fallback——目标项目缺省用主分身知道的 activeProjectId
      const targetProjectId = args.target_project_id ?? ctx.activeProjectId ?? null;
      if (!targetProjectId) {
        return {
          isError: true,
          text:
            '当前没有 active 项目，无法新建 deck。请先让用户在左侧栏添加一个项目（或在 chat 里让 AI 帮忙创建），' +
            '然后重新调用 propose_deck_create。',
        };
      }
      // 引导安装（§六）：将要用的 deck skill 没装时，先当场把它装上、不硬报错。
      // 装完模型再调一次 propose_deck_create 即可续跑（全新环境开箱有底）。
      // 卡片信息直接取自内置清单（不在此刻做网络 clone——clone 推迟到真装那一步）。
      const deckSkillId = args.deck_skill_id ?? DEFAULT_DECK_SKILL_ID;
      if (!(await isDeckSkillInstalled(deckSkillId))) {
        const curated = findCuratedDeckSkill(deckSkillId);
        if (!curated) {
          return {
            isError: true,
            text:
              `deck skill "${deckSkillId}" 还没安装，也不在内置引导清单里。` +
              `请先用 propose_skill_install 给出它的 GitHub 仓库地址装上，或改用一个已装的 deck skill。`,
          };
        }
        const installProposal = buildSkillInstallProposal({
          conversationId: ctx.conversationId,
          title: `先装 deck skill ${curated.name}`,
          description: `做 deck 需要先装一个 deck skill。${curated.note}（${curated.license}）`,
          skillId: curated.id,
          skillManifest: { name: curated.name, description: curated.note },
          // commit 留空 = 安装时用 HEAD；skillSubdir 留空 = 安装时在仓库内自动定位 SKILL.md
          source: { type: 'github', url: curated.repo, commit: '' },
          skillSubdir: '',
          license: curated.license,
        });
        // 引导安装同样等真结果：装成了就直说「装好了，可以再调一次」，没装成别让模型干等。
        return await proposeOrExecuteEnvChange(ctx, installProposal, {
          // 本工具声明 mutatesEnvironment: false、不受中央闸管；只读挡下既有行为是弹卡等用户批准。
          readonlyPolicy: 'ask',
          approvalText: `做 deck 需要先装 deck skill「${curated.name}」，但当前环境没有可确认的界面，未安装。`,
          perform: async () => {
            const { performSkillInstall } = await import('../../skills/installer');
            const r = await performSkillInstall(installProposal);
            return {
              text: `deck skill「${r.name}」已装好，现在再调一次 propose_deck_create 就能建 deck 了。`,
              outcome: { ok: true, name: r.name },
            };
          },
        });
      }

      const proposal = buildDeckCreateProposal({
        conversationId: ctx.conversationId,
        deckName: args.deck_name,
        targetProjectId,
        deckSkillId,
        brief: args.brief,
        sizeHint: args.size_hint,
        etaHint: args.eta_hint,
        narrative: args.narrative,
        autoGenerate: args.auto_generate ?? false,
      });
      const tail = proposal.autoGenerate
        ? `建壳后会立即派 subagent 调用 ${proposal.deckSkillId} 按叙事文稿生成 HTML。`
        : `建壳后停在文稿可见可改的状态——用户过目/修改后用 generate_deck（或点空状态的"生成"按钮）触发生成。`;
      return await proposeOrExecuteEnvChange(ctx, proposal, {
        readonlyPolicy: 'ask', // 同上：只读挡下 deck 仍可由用户亲自批准建出来
        approvalText: `当前环境没有可确认的界面，未新建 deck "${args.deck_name}"。`,
        perform: async () => {
          const { performDeckCreate } = await import('../../proposals/performDeckCreate');
          // 建壳要广播 artifact.state 让前端切四列布局——与 generate_deck 同款，取 ws/server 的全局广播
          // （ToolContext 无通用 broadcast，deck 链路既有约定就是直接取它）。
          const { broadcast } = await import('../../ws/server');
          const r = await performDeckCreate(proposal, broadcast);
          return {
            text: r.dispatched
              ? `deck "${args.deck_name}" 的壳已建好，生成 subagent 已派出，完成后预览会自动刷新。`
              : `deck "${args.deck_name}" 的壳已建好，叙事文稿已写入「文稿」标签，等用户过目后再生成。`,
          };
        },
      });
    },
  };
}
