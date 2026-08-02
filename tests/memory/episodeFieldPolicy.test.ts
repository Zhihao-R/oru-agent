/**
 * 字段政策对账：两条 episode 写入通道必须引用同一份政策，不得各自手写
 *
 * 起因是真实漂移——record_memory（tools.ts 的 schema）与 capture（守则）曾对同一字段
 * 给出相反口径：userRequested 一处"必填表态"、一处"平时省略"，description 则是逐字誊抄
 * 再改两字。抽出 EPISODE_FIELD_POLICY 只保证「这一次」改对了，这道测试保证以后有人
 * 手写字符串覆盖掉引用时会红。
 */
import { describe, expect, it } from 'vitest';
import { EPISODE_FIELD_POLICY } from '../../electron/main/memory/episodeFieldPolicy';
import { CAPTURE_SYSTEM_PROMPT, CAPTURE_OUTPUT_SCHEMA } from '../../electron/main/memory/capturePrompt';
import { createMemoryTools } from '../../electron/main/memory/tools';

type JsonSchema = {
  properties?: Record<string, { description?: string }>;
  required?: string[];
};

function recordMemoryProperties(): Record<string, { description?: string }> {
  const tool = createMemoryTools().find((t) => t.name === 'record_memory');
  expect(tool, 'record_memory 工具不存在了？').toBeDefined();
  const schema = tool!.inputSchema as JsonSchema;
  return schema.properties ?? {};
}

describe('EPISODE_FIELD_POLICY 两通道对账', () => {
  it('record_memory 的 schema description 都由政策句打底（不是手写副本）', () => {
    const props = recordMemoryProperties();
    for (const field of ['content', 'title', 'description', 'tags', 'projectId', 'userRequested'] as const) {
      expect(props[field]?.description, `record_memory.${field} 脱离了共享政策`).toContain(
        EPISODE_FIELD_POLICY[field],
      );
    }
  });

  it('capture 守则里同样逐字带着这几句政策', () => {
    for (const field of ['content', 'title', 'description', 'tags', 'projectId', 'userRequested'] as const) {
      expect(CAPTURE_SYSTEM_PROMPT, `capture 守则的 ${field} 口径脱离了共享政策`).toContain(
        EPISODE_FIELD_POLICY[field],
      );
    }
  });

  it('两通道都强制模型对 userRequested 表态——可选参数会被系统性忽略', () => {
    // 通道一靠 schema required；通道二靠 CAPTURE_OUTPUT_SCHEMA 的 payload required。
    // 少了任何一侧，「用户嘱记过」这个痕迹在那条通道上就静默丢失（事后无从补记）。
    const tool = createMemoryTools().find((t) => t.name === 'record_memory');
    expect((tool!.inputSchema as JsonSchema).required).toContain('userRequested');

    const captureSchema = CAPTURE_OUTPUT_SCHEMA as {
      properties: { operations: { items: { properties: { payload: JsonSchema } } } };
    };
    const payload = captureSchema.properties.operations.items.properties.payload;
    expect(payload.required).toContain('userRequested');
    // 声明成布尔才挡得住模型吐字符串 "false"（applyOps 真值判断下会把自发记的误标成用户嘱记）
    expect(payload.properties?.userRequested).toMatchObject({ type: 'boolean' });
  });
});
