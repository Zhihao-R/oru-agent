/**
 * 飞书办公能力（§B keystone → S2 工具化）—— 让模型知道「我能读写飞书文档/表格/日历」。
 *
 * 方法论（抄 OpenClaw/Hermes，见 docs/research/2026-06-22-agent-context-organization.html §3）：
 * 能力靠「存在性 + 真连接门控」讲，不靠 prompt 散文。**没配飞书就不注入这段**（buildPrompt
 * 返回 null），模型结构上就不知道有这能力，也编不出「写飞书文档/装 MCP 硬敲」。
 *
 * S2 起不再是 prompt-only：云文档读写收敛进 feishu_doc 工具（makeTools 注入，内核跑
 * runLarkCli——结构化错误 / authFailure / 超时杀进程组现成），取代「模型裸 bash 调
 * lark-cli」（08-01 PATH 事故的根）。多维表格 / 日历 / 云空间等其余域没有专用工具，
 * 仍由模型经 bash 跑 lark-cli（被 bashCommand 挡位识别）——prompt 只对这部分指路。
 *
 * 门控用 hasCredential('feishu') 作快代理（文件读，每轮可跑）：配了凭证即视为可用——保存凭证时已后台
 * 自动 config init（feishuSetup）。真没配好时，prompt 让模型先 doctor/auth scopes 自查兜底。
 */
import type { Capability } from '../types';
import { hasCredential } from '../../../platform/credentialStore';
import { makeFeishuDocTool } from '../../agentTools/feishuDoc';

/**
 * 「指路」prompt——只给入口与铁律，不抄文档。文档读写指向 feishu_doc 工具；
 * 其余域指向 lark-cli 自带的 skills / auth scopes / doctor（常驻 prompt 不背用法，零漂移、版本匹配）。
 * 注：`lark-cli` 只在「全局安装且 Oru 进程 PATH 覆盖其 bin」时裸可跑——并非所有机器满足，
 * 撞 command not found ≠ 没装：用 `npx @larksuite/cli@latest auth status` 自查，ready 再决定用裸命令或 npx。
 */
export const LARK_CAPABILITY_PROMPT = `## 飞书办公
你能读写飞书云文档 / 多维表格 / 日历（凭证已由「平台连接」配好）。
- 云文档读写：用 feishu_doc 工具（fetch 读 / create 建 / update 改），别自己敲 lark-cli 的 docs 命令。
- 多维表格 / 日历 / 云空间等其余操作：经 bash 跑 \`lark-cli\`（受挡位管控）；动手前先 \`lark-cli skills read <对应 skill>\` 拿版本匹配的用法，别凭 --help 或记忆猜参数 / 格式。撞 command not found 别下「没装」结论，先 \`npx @larksuite/cli@latest auth status\` 自查（npx 会判装包命令过审批卡，属正常）。
- 不确定连没连、有哪些权限：跑 \`lark-cli auth scopes\` 或 \`lark-cli doctor\` 自查，别去查 MCP 列表。
- 文档归属：feishu_doc 默认 user 身份、文档归你本人；只有明确需要应用身份时才用 identity=bot。
- 撞 \`app_scope_not_applied\`：把报错里的申请链接发给用户，让其在开放平台开权限，别自己绕路。`;

export const larkCapability: Capability = {
  id: 'lark',
  // 仅 twinMain：它既是 field「帮我写飞书文档」的对话主体（桌面 + 平台 turn 都以 twinMain
  // provision）、又能在只读挡之外真写。scheduledRun 同在（定时任务「整理成飞书文档」场景）。
  // twinBackground / subagentCoder 不 field 飞书请求，给了就是「承诺没有的能力」（正是 §E 要堵的）。
  audience: ['twinMain', 'scheduledRun'],
  makeTools: [makeFeishuDocTool],
  // 没配飞书 → 返回 null → 不注入（门控即能力的有无）。
  buildPrompt: async () => ((await hasCredential('feishu')) ? LARK_CAPABILITY_PROMPT : null),
};
