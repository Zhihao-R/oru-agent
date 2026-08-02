/**
 * JSON Schema → zod 转换回归。
 *
 * 锁的目标问题：**自由字典参数不能被静默剥空**。`{ type:'object' }` 且无 properties 的属性
 * （env / headers 这类键名不定的映射）若落成 `z.object({})`，zod 的 strip 语义会把所有键剥光
 * 且不报错——SDK 在调 handler 前会 safeParse，工具于是拿着空对象照常"成功"返回。这是算错
 * 而非失灵：落盘与上屏的 tool_use input 是模型产出的完整版，事后排查看不出差异。
 *
 * 真实受害者两个：Oru 自有的 mcp_install（env 里的 token 在 claude-code 后端下一直在丢），
 * 以及外部 MCP 改走反射后所有带自由字典参数的第三方工具。
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  jsonSchemaToZodShape,
} from '../../electron/main/agent/backends/jsonSchemaToZod';

describe('jsonSchemaToZod — 自由字典参数原样透传', () => {
  it('无 properties 的 object 属性不被剥空（env 里的键值原样到达工具）', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        name: { type: 'string' },
        env: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['name'],
    });

    // SDK 侧就是这么用 shape 的：z.object(shape) 后 safeParse，结果才传给 handler
    const parsed = z.object(shape).parse({ name: 'srv', env: { API_KEY: 'secret', PORT: '1' } });

    expect(parsed).toEqual({ name: 'srv', env: { API_KEY: 'secret', PORT: '1' } });
  });

  it('声明了 properties 的 object 仍按声明收窄（未声明的键照旧剥掉，不放宽成 passthrough）', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        opts: { type: 'object', properties: { depth: { type: 'number' } } },
      },
    });

    const parsed = z.object(shape).parse({ opts: { depth: 2, sneaky: 'x' } });

    expect(parsed).toEqual({ opts: { depth: 2 } });
  });

  it('root schema 非 object 仍抛错（调用方逐工具 try/catch 接住并跳过该工具）', () => {
    expect(() => jsonSchemaToZodShape({ type: 'string' })).toThrow();
  });
});
