/**
 * bash AgentTool —— 在用户电脑执行命令（万能后备，本期最强也最危险）。
 *
 * 注册架构（决策 6.8 + 2026-07-30 行为分类拍板）：
 *   - **始终注册**（模型可见可调）；无能力审批层——命令能力门已取消（决策 6）：bash 与其他
 *     工具对齐，只有行为审批（破坏性 / 未知命令 / 覆盖 / 对外投递各自弹卡，可整类免卡）。
 *   - 下放给 subagent（twinMain/subagentCoder/twinSubagent 均可）——subagent 的每个操作再逐个过闸，
 *     副作用工具的审批卡回流主对话标「来自 subagent」（G78/G48）；只 asideComment 只读短评剔除 bash。
 *
 * 安全：analyzeBashCommand 判破坏性（证明安全/看不透就判破坏，决策 6.3；看不透单列「未知命令」）。
 * 破坏性命令即使无审批也经 forceApproval 停下等用户确认；确认后（或信任模式直接）由
 * runBashCommand 执行，真实输出回模型。
 */
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import type { DeliveryTarget } from '@shared/types';
import { analyzeBashCommand, collectDelivery, isReadOnlyCommand } from '../../fs/bashCommand';
import { addressesPinnedByUser } from '../outbound/deliveryGate';
import { declaredOutputs } from '../../table/scriptOutputs';
import { buildBashProposal } from '../../proposals/makeBashProposal';
import { defaultSearchRoot } from './pathSandbox';
import {
  resolveExpectedFiles,
  snapshotExpectedFiles,
  verifyExpectedChanges,
} from './expectedFileChanges';
import type { StructuredMarkers } from '@shared/agent/structuredMarkers';
import { proposeOrExecute } from './emitProposal';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '../../proposals/executeBashProposal';

const TOOL_DESC = `在用户电脑上执行 shell 命令——装包、跑脚本、git、批量文件操作、格式转换、移动/重命名等没有专门工具但一条命令能解决的事。

**职责边界（别抢专门工具）**：
- 读文件优先 read_file；写/新建文件优先 write_file；改文件一处优先 edit_file；搜内容用 grep；找文件用 glob；列目录用 list_dir；删除（可恢复）用 manage_files。
- bash 用于上述之外：装工具（brew/npm…）、跑脚本（python/node…）、版本管理（git）、批量/移动/重命名（mv/批处理）、格式转换（ffmpeg…）。

**安全**：只读/安全命令（ls/cat/git status 等）顺畅执行；破坏性命令（rm/mv/覆盖重定向/sudo/装卸软件等）与看不透的未知命令即使在无审批模式下也会先让用户确认一次。

入参：command（必填）、timeout（毫秒，可选，默认 ${DEFAULT_TIMEOUT_MS / 60000} 分钟、上限 ${MAX_TIMEOUT_MS / 60000} 分钟）、description（人话，可选，给用户看这条命令干啥）、run_in_background（可选，长任务返回 taskId 后台跑）、expected_files（可选，但**会动文件的命令必须填**——这条命令预期会新建/修改/删除的文件路径列表。包括命令字面上看不到的间接产出：跑脚本生成的文件（如 python3 gen.py 产出的 PDF）、重定向写入、构建产物，都要填，填的是最终落盘的文件路径、不是脚本路径。执行后系统逐个核验，确实变动的进对话里的「本轮文件变更」记录，让用户看得见你动了什么；不填用户就永远看不见这些改动）。

cwd 固定为 active 项目根（无则 agent 沙盒）。前台命令超过上限会被终止；预计跑很久的命令（构建、长测试、起服务等）用 run_in_background——后台不受超时限制，跟随对话存活。失败/超时会把原因如实返回。`;

export function makeBashTool(): AgentTool {
  return {
    name: 'bash',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令（必填）' },
        timeout: { type: 'number', description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}（仅前台；后台不受限）` },
        description: { type: 'string', description: '人话描述这条命令干什么（给用户看）' },
        run_in_background: { type: 'boolean', description: '后台跑长任务，返回 taskId' },
        expected_files: {
          type: 'array',
          items: { type: 'string' },
          description:
            '预期会新建/修改/删除的文件路径（绝对或相对工作目录），会动文件的命令必填：含脚本间接产出、重定向、构建产物，填最终落盘路径；执行后核验，确实变动的进「本轮文件变更」',
        },
      },
      required: ['command'],
    },
    // G103：命令输出不可重现（网页抓取、长命令输出同类），无论大小都落盘保真——当轮 wire
    // 上模型仍看全文，落盘的 preview（带 read_file 引导行）从后续轮起替代全文进视野，日后被折叠
    // 也只是收进磁盘、循路径可读回。前台回执覆盖此；后台命令（run_in_background）的输出落盘归 S19。
    persistPolicy: 'always',
    async execute(input, ctx): Promise<ToolResult> {
      const args = (input ?? {}) as {
        command?: string;
        timeout?: number;
        description?: string;
        run_in_background?: boolean;
        expected_files?: unknown;
      };
      if (typeof args.command !== 'string' || args.command.trim().length === 0) {
        return { isError: true, text: 'bash: command 不能为空' };
      }

      let timeout = args.timeout;
      if (timeout !== undefined) {
        if (!Number.isFinite(timeout) || timeout <= 0) timeout = DEFAULT_TIMEOUT_MS;
        if (timeout > MAX_TIMEOUT_MS) timeout = MAX_TIMEOUT_MS;
      }

      // cwd 固定可预测 = active 项目根 ?? agent 沙盒（决策 6.6）；路径硬防线按同一 cwd 解析相对路径。
      // 无可预测根时报错而非落到 process.cwd()（Electron 主进程 cwd 不可预测，会架空路径硬防线）。
      const cwd = await defaultSearchRoot(ctx);
      if (!cwd) {
        return { isError: true, text: 'bash: 没有可预测的工作目录（无 active 项目、无 agent 沙盒），暂不执行命令' };
      }
      const analysis = analyzeBashCommand(args.command, cwd);
      // 只读判定（白名单 fail-closed）：只读挡下据此放行/拒。对话分身与后台 subagent 同口径。
      const isReadOnly = isReadOnlyCommand(args.command).ok;

      // 脚本写文件总守卫（表格 PRD 场景三）：命令引用的脚本声明的输出已存在 → 卡片升级
      // 覆盖确认态（forceApproval），确认前文件不被触碰
      const declared = await declaredOutputs(args.command, cwd).catch(() => [] as string[]);
      const overwriteTargets = declared
        .filter((abs) => existsSync(abs))
        .map((abs) => relative(cwd, abs) || abs);

      // 对外投递（S04 · G74）：**按段**免除——仅当该段自身提取到地址且全部逐字来自用户消息，
      // 该段才不算投递（「按只读放行」在 bash 面收窄为不算投递档，其余判定照旧——curl 兼具
      // 写盘面，只读白名单 fail-closed 不为它开洞）。不按提案级合取：否则 `curl 用户地址; nc 攻击者`
      // 里提不出地址的段会被同批 pinned 段"搭车"免闸。本对话已批过全部目标 → 免卡但 delivery
      // 仍上提案（S26 送达收口按此识别外发）。
      const deliveryTargets: DeliveryTarget[] = [];
      for (const seg of analysis.segments) {
        if (!seg.delivery) continue;
        const pinned =
          seg.delivery.addresses.length > 0 &&
          (await addressesPinnedByUser(seg.delivery.addresses, ctx.agentId, ctx.conversationId));
        if (!pinned) deliveryTargets.push(...collectDelivery([seg]).targets);
      }
      // 投递档存在即需过审批（forceApproval）；是否免卡由 emit 端按 isGranted 持久授权判（§4.1）。
      const deliveryNeedsApproval = deliveryTargets.length > 0;

      const proposal = buildBashProposal({
        conversationId: ctx.conversationId,
        command: args.command,
        description: args.description,
        isDestructive: analysis.isDestructive,
        isReadOnly,
        segments: analysis.segments,
        timeout,
        runInBackground: args.run_in_background,
        cwd,
        overwriteTargets,
        delivery: deliveryTargets,
        deliveryNeedsApproval,
      });

      const approvalText = `已递交命令执行提案：${args.command}${analysis.isDestructive ? '（破坏性，需用户确认）' : deliveryNeedsApproval ? '（对外投递，需用户确认）' : '（需用户确认）'}`;
      return proposeOrExecute(ctx, proposal, {
        approvalText,
        // 信任模式（非破坏性）直接执行；审批模式由用户点确认后执行。两条都把命令输出
        // 作为工具结果返回（chip 即见输出）。长任务由模型传 run_in_background=true 立即返回 taskId。
        // 「始终允许」的持久授权（{destructive}/{unknown}/…）由 settleApprovalDecision 写入，不在此置位。
        execute: async () => {
          const { runBashCommand } = await import('../../proposals/executeBashProposal');
          // 预期申报核验（PRD 第 7 项）：快照放在审批通过后、命令真正要跑之前——审批等待期
          // 用户自己的改动不算这条命令的产出。
          const expected = resolveExpectedFiles(args.expected_files, cwd);
          const snapshot = expected.length > 0 ? snapshotExpectedFiles(expected) : null;
          // 透传 abortSignal：用户取消任务（cancelTask → ac.abort()）时，正在跑的前台命令子进程组立即被杀（B 块）
          // 透传 onCommandOutput（G19）：前台长命令边跑边把输出推给 UI 滚动显示。
          const { result, inlineText } = await runBashCommand(
            proposal,
            ctx.abortSignal,
            ctx.onCommandOutput,
          );
          // 前台 exitCode=null 只有一种来路：被取消/杀进程组（正常结束必有码）——归 failed，
          // 取消的命令不附标记（PM 2026-07-28 裁决）。后台启动成功时 exitCode 恒 null，不适用此判。
          const failed =
            result.timedOut || (result.taskId ? false : result.exitCode !== 0);
          // 后台命令：把登记表 id 作为结构化标记回渲染层（工具行据此接活状态：脉冲 + 时长 + 看输出）。
          // 返回时命令还没跑完，无从核验申报——不附 fileChanges（漏报是三层方案接受的残余风险）。
          if (result.taskId) {
            return {
              text: inlineText,
              isError: failed,
              structured: { backgroundCommand: { id: result.taskId } } satisfies StructuredMarkers,
            };
          }
          // 前台且成功才核验申报：失败回执 isError，读端本就不采信其标记，不留死数据。
          const fileChanges = snapshot && !failed ? verifyExpectedChanges(snapshot) : [];
          return {
            text: inlineText,
            isError: failed,
            structured:
              fileChanges.length > 0 ? ({ fileChanges } satisfies StructuredMarkers) : undefined,
          };
        },
      });
    },
  };
}
