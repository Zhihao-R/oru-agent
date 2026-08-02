/**
 * feishu_doc AgentTool —— 飞书云文档读写（S2 lark-cli 工具化 → S4 bot 内核换 SDK → S5 user 内核换 UAT）。
 *
 * 取代「模型裸 bash 调 lark-cli」的文档路径（08-01 事故的根：PATH 假设错就被误判「没装」、
 * 输出靠模型自己解析、超时/杀进程组靠模型自觉）。工具签名（name/schema/description）不动，
 * 模型无感；内核按身份分流，两身份都是进程内调用（零 spawn——lark-cli 退为运维工具）：
 * - identity=user（默认）→ UAT 内核（platform/feishuDocsAi.ts + feishuUat.ts：Bearer fetch 直调
 *   docs_ai，token 来自 feishuUserToken 独立 0600 文件，失效自动刷新/引导重授权）。
 * - identity=bot → SDK 内核（Lark.Client 直调，凭证来自 credentialStore）。
 * 两内核共用同一份 lark-cli v2 对拍（body 构造 / 校验 / 错误分类 / 输出信封）。
 *
 * 行为分流：
 * - 读（fetch）：任何挡位直执行、不构造提案（对齐 read_file——读不是写）。
 * - 写（create/update）：走 proposeOrExecute 统一提案流（对齐 write_file——工作/全放挡
 *   直执行、只读挡拒），提案 kind 'feishu.doc'。
 * - authFailure：工具结果带「需要重新授权」指引如实透传，模型转告用户，不沉默不装成功。
 *
 * 内核只认 docs 域三个 shortcut（+fetch/+create/+update）；多维表格 / 日历 / drive 等其余域
 * 仍由模型经 bash 跑 lark-cli（capability prompt 指路），本工具不做全家桶（克制）。
 */
import type { AgentTool, ToolContext, ToolResult } from '@shared/agent/backend';
import type { FeishuDocProposal } from '@shared/types';
import { newProposalId } from '@shared/ids';
import {
  makeDefaultDocsAiKernel,
  makeUserDocsAiKernel,
  type FeishuDocKernel,
  type FeishuDocOutcome,
} from '../../platform/feishuDocsAi';
import { getCurrentOwnerId } from '../../identity/getCurrentOwnerId';
import { proposeOrExecute } from './emitProposal';

type Identity = 'user' | 'bot';
// 枚举即承诺：只列模型真能选成的值。block_copy_insert_after / block_move_after 需要 srcBlockIds、
// fetch 的 range/keyword/section 需要锚点参数——schema 没有这些参数，列出来是恒失败的死路
// （内核层的对拍校验仍在，防直接调内核的调用方，见 feishuDocsAi.ts）。
const UPDATE_COMMANDS = [
  'str_replace',
  'append',
  'overwrite',
  'block_insert_after',
  'block_replace',
  'block_delete',
] as const;

type FeishuDocInput = {
  op?: string;
  doc?: string;
  identity?: string;
  title?: string;
  content?: string;
  format?: string;
  command?: string;
  pattern?: string;
  blockId?: string;
  scope?: string;
  detail?: string;
};

const TOOL_DESC = `读写飞书云文档（Docx / Wiki 文档）。飞书相关的文档读写一律用本工具，不要自己敲 lark-cli。

- op=fetch：读文档。doc 给文档 URL 或 token；默认全文，scope=outline 只读大纲。
- op=create：建新文档。content 给正文（默认 XML，用户明确要求 Markdown 时 format=markdown + title）。
- op=update：改已有文档。command 选 str_replace（配 pattern）/ append / overwrite / block_insert_after / block_replace / block_delete（后三个配 blockId）。

身份：默认 user（文档归本人所有）；identity=bot 归应用（会自动授权给已绑定的飞书用户可管理）。

写正文前必须先读官方格式规范（版本匹配，别凭记忆猜）：bash 跑
\`lark-cli skills read lark-doc references/lark-doc-xml.md\`（Markdown 则 references/lark-doc-md.md）。

撞权限不足（app_scope_not_applied）时把报错里的申请链接发给用户开通，别自己绕路；
撞授权失效时如实告诉用户需要重新授权，不要假装成功。`;

export function makeFeishuDocTool(
  userKernel: FeishuDocKernel = makeUserDocsAiKernel(),
  botKernel: FeishuDocKernel = makeDefaultDocsAiKernel(),
): AgentTool {
  return {
    name: 'feishu_doc',
    // 条件变更（同 bash）：fetch 纯读、create/update 写——只读拒由 proposeOrExecute 内自判，
    // 不能交给中央闸无条件拒，否则只读挡下连读文档都做不到。
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['fetch', 'create', 'update'], description: '操作：读 / 建 / 改' },
        doc: { type: 'string', description: '文档 URL 或 token（fetch / update 必填）' },
        identity: { type: 'string', enum: ['user', 'bot'], description: '身份，默认 user（文档归本人）' },
        title: { type: 'string', description: '文档标题（create 时可选；Markdown 导入建议给）' },
        content: { type: 'string', description: '正文内容（XML 默认；format=markdown 时给 Markdown）' },
        format: { type: 'string', enum: ['xml', 'markdown'], description: '内容格式，默认 xml' },
        command: {
          type: 'string',
          enum: UPDATE_COMMANDS,
          description: 'update 的操作类型',
        },
        pattern: { type: 'string', description: 'str_replace 的匹配文本' },
        blockId: { type: 'string', description: 'block_* 操作的目标 block id（批量用逗号分隔）' },
        scope: { type: 'string', enum: ['full', 'outline'], description: 'fetch 的读取范围' },
        detail: { type: 'string', enum: ['simple', 'with-ids', 'full'], description: 'fetch 的明细级别' },
      },
      required: ['op'],
    },
    async execute(input, ctx): Promise<ToolResult> {
      const args = (input ?? {}) as FeishuDocInput;
      // 身份分流：user（默认）走 UAT 内核、bot 走 SDK 内核——两路都进程内，零 spawn
      const identity: Identity = args.identity === 'bot' ? 'bot' : 'user';
      const kernel = identity === 'bot' ? botKernel : userKernel;

      switch (args.op) {
        case 'fetch': {
          if (!args.doc?.trim()) return { isError: true, text: 'feishu_doc: fetch 需要 doc（文档 URL 或 token）' };
          return report(await kernel.fetch({ doc: args.doc, scope: args.scope, detail: args.detail, format: args.format }), 'fetch');
        }
        case 'create': {
          if (typeof args.content !== 'string' || args.content.length === 0) {
            return { isError: true, text: 'feishu_doc: create 需要 content（正文）' };
          }
          const content = args.content; // 收口类型：闭包内属性收窄不保留
          const label = args.title ? `《${args.title}》` : '';
          return proposeOrExecute(ctx, makeProposal(ctx, { op: 'create', identity, title: args.title }), {
            approvalText: `已递交创建飞书文档${label}的提案，待确认后执行`,
            execute: async () => report(await kernel.create({ title: args.title, format: args.format, content }), 'create'),
          });
        }
        case 'update': {
          if (!args.doc?.trim()) return { isError: true, text: 'feishu_doc: update 需要 doc（文档 URL 或 token）' };
          if (!args.command || !(UPDATE_COMMANDS as readonly string[]).includes(args.command)) {
            return { isError: true, text: `feishu_doc: update 需要 command（${UPDATE_COMMANDS.join(' / ')}）` };
          }
          const command = args.command; // 收口类型：闭包内属性收窄不保留
          const doc = args.doc;
          return proposeOrExecute(ctx, makeProposal(ctx, { op: 'update', identity, doc }), {
            approvalText: `已递交更新飞书文档的提案（${command}），待确认后执行`,
            execute: async () =>
              report(
                await kernel.update({
                  doc,
                  command,
                  pattern: args.pattern,
                  blockId: args.blockId,
                  format: args.format,
                  content: args.content,
                }),
                'update',
              ),
          });
        }
        default:
          return { isError: true, text: `feishu_doc: 未知 op（${String(args.op)}），支持 fetch / create / update` };
      }
    },
  };
}

/** outcome → ToolResult（两内核共用）：成功回正文；authFailure 给重授权指引；其余失败如实带细节。 */
function report(outcome: FeishuDocOutcome, opLabel: string): ToolResult {
  if (outcome.ok) return { text: outcome.text };
  if (outcome.authFailure.needsReauth) {
    return {
      isError: true,
      text:
        `飞书授权失效${outcome.authFailure.hint ? `（${outcome.authFailure.hint}）` : ''}，本次 ${opLabel} 未执行成功。\n` +
        '请如实告诉用户：飞书登录已失效，需要到「设置 ▸ 平台连接」重新完成飞书授权后再试——不要假装成功。',
    };
  }
  return { isError: true, text: `feishu_doc ${opLabel} 失败：${outcome.text}` };
}

function makeProposal(
  ctx: ToolContext,
  meta: { op: 'create' | 'update'; identity: Identity; doc?: string; title?: string },
): FeishuDocProposal {
  return {
    kind: 'feishu.doc',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: ctx.conversationId,
    title: meta.op === 'create' ? '创建飞书文档' : '更新飞书文档',
    description: meta.op === 'create' ? (meta.title ?? '（无标题）') : `${meta.doc}`,
    createdAt: Date.now(),
    op: meta.op,
    identity: meta.identity,
    ...(meta.doc !== undefined ? { doc: meta.doc } : {}),
    ...(meta.title !== undefined ? { title: meta.title } : {}),
  };
}
