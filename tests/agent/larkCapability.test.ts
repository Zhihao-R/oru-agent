/**
 * 飞书办公能力（§B keystone → S2 工具化）—— 门控在真连接上的「能力即工具/CLI 存在性」做法（抄 OpenClaw/Hermes）。
 *
 * 关键不变量：**没配飞书 → buildPrompt 返回 null → 能力 prompt 不注入 → 模型结构上不知道有这能力**，
 * 也就编不出「我能写飞书文档」「装个 MCP 硬敲」这类瞎话（根治那两个 bug 的一半）。
 * 配了飞书 → 注入「指路」prompt：文档读写指向 feishu_doc 工具、其余域指向 lark-cli skills、
 * auth scopes 自查、默认 user 身份归本人。
 *
 * 用 vi.mock 把 hasCredential 拨成两态，验门控 + 内容关键指令在场 + 工具挂载。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { hasCredential } = vi.hoisted(() => ({ hasCredential: vi.fn<(p: 'feishu' | 'discord') => Promise<boolean>>() }));
vi.mock('../../electron/main/platform/credentialStore', () => ({ hasCredential }));

import { larkCapability } from '../../electron/main/agent/capabilities/builtins/lark';

const ctx = { usage: 'twinMain' as const, searchBudgetId: 'b', activeProjectId: null };

beforeEach(() => hasCredential.mockReset());

describe('larkCapability 门控', () => {
  it('没配飞书 → 不注入（返回空/null，模型不知道有这能力）', async () => {
    hasCredential.mockResolvedValue(false);
    const p = await larkCapability.buildPrompt!(ctx);
    expect(p == null || p === '').toBe(true);
    expect(hasCredential).toHaveBeenCalledWith('feishu');
  });

  it('配了飞书 → 注入「指路」prompt，含承重指令', async () => {
    hasCredential.mockResolvedValue(true);
    const p = (await larkCapability.buildPrompt!(ctx)) ?? '';
    expect(p).toContain('feishu_doc'); // 文档读写指向工具（S2：不再教模型裸敲 bash 的 docs 命令）
    expect(p).toContain('skills read'); // 其余域用前先读官方 skill（不自写、版本匹配）
    expect(p).toMatch(/auth scopes|doctor/); // 自省入口（不查 mcp_list）
    expect(p).toMatch(/user 身份|归.*本人/); // 默认 user 身份、文档归本人
  });

  it('S2 起带 feishu_doc 工具（audience 不变：twinMain + scheduledRun）', () => {
    const tools = (larkCapability.makeTools ?? []).map((make) => make());
    expect(tools.map((t) => t.name)).toEqual(['feishu_doc']);
    expect(larkCapability.audience).toEqual(['twinMain', 'scheduledRun']);
  });
});
