/**
 * 浏览器操控声明式能力（S33 · §8）——注册面。
 *
 * 验三件承重事：
 *  1. 六件走声明式 Capability 注入（不挂旧式 WEB 桶），audience 对齐 webSearchCapability——
 *     定时任务（scheduledRun）与对话期 subagent（twinSubagent）的「订票比价 / 联网操作」场景不漏。
 *  2. 六件整体追加在工具注册表末尾、表内按 capabilities.html 工具表顺序——工具列表是
 *     system prompt 的一部分，插中间会击穿 prompt cache（index.ts:46 约束）。
 *  3. usages 与 audience 一致：三后端都从同一注册表按 usage 注入，audience 即可见性单源。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { registerStaticAgentTools } from '../../electron/main/agent/agentTools';
import { registerBuiltinCapabilities } from '../../electron/main/agent/capabilities';
import {
  listRegisteredToolNames,
  __listRegisteredToolsForTest,
} from '../../electron/main/agent/backends/factory';
import { browserControlCapability } from '../../electron/main/agent/capabilities/builtins/browserControl';
import { webSearchCapability } from '../../electron/main/agent/capabilities/builtins/webSearch';

const SIX = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_back',
] as const;

beforeAll(() => {
  registerStaticAgentTools();
  registerBuiltinCapabilities();
});

describe('浏览器操控能力注册', () => {
  it('六件整体追加在注册表末尾、按 capabilities.html 工具表顺序（prompt cache）', () => {
    const names = listRegisteredToolNames();
    expect(names.slice(-6)).toEqual([...SIX]);
  });

  it('audience 对齐 webSearchCapability（同为联网族，定时任务 / subagent 场景不漏）', () => {
    expect(browserControlCapability.audience).toEqual(webSearchCapability.audience);
  });

  it('注册表 usages 与 audience 一致（可见性单源，三后端同一注入循环）', () => {
    const entries = __listRegisteredToolsForTest().filter((e) =>
      (SIX as readonly string[]).includes(e.tool.name),
    );
    expect(entries).toHaveLength(6);
    for (const e of entries) {
      expect(e.usages, e.tool.name).toEqual(browserControlCapability.audience);
    }
  });
});
