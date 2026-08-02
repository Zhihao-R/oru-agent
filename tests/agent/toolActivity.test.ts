/**
 * subagent 运行态卡底行翻译层测试。
 * 后端 toolObject 挑宾语、前端 toolActivityText 翻人话——是"当前在干什么"那行的真源。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';
import { toolObject, toolActivityText, shorten } from '../../shared/agent/toolActivity';
import { normalizeToolName } from '../../shared/agent/toolName';

// toolActivityText 是 @shared formatter，纯函数不持 i18n、接外部译者（约定见 CLAUDE.md）。
// 测试构一个钉死 zh 的实例传进去，断言既有中文文案。
let tt: (key: string, params?: Record<string, unknown>) => string;
beforeAll(async () => {
  const i = createInstance();
  await i.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
  tt = (k, p) => i.t(k, p);
});

// 回归：claude-code 把 oru 工具桥成 MCP server，事件名带 mcp__oru__ 前缀，
// 精确匹配 TOOL_SPECS 曾静默失效（运行态卡只显示兜底文案）
describe('normalizeToolName（前缀归一）', () => {
  it('剥 mcp__oru__ 前缀取裸名', () => {
    expect(normalizeToolName('mcp__oru__read_file')).toBe('read_file');
  });
  it('裸名与单下划线名原样保留', () => {
    expect(normalizeToolName('Edit')).toBe('Edit');
    expect(normalizeToolName('read_file')).toBe('read_file');
  });
  it('查表对 oru 前缀免疫：带前缀与裸名结果一致', () => {
    const input = { file_path: '/a/b/capture.ts' };
    expect(toolObject('mcp__oru__Edit', input)).toBe('capture.ts');
    expect(toolActivityText('mcp__oru__Bash', 'npm', tt)).toBe('跑 npm');
  });
  it('attacker：外部 MCP 工具名（非 oru 前缀）不归一——末段撞裸名也不冒充', () => {
    expect(normalizeToolName('mcp__github__read_file')).toBe('mcp__github__read_file');
    // 查表不命中 → 通用兜底，不套用 Oru 工具的语义
    expect(toolObject('mcp__sdk__Edit', { file_path: '/a/b/capture.ts' })).toBeUndefined();
    expect(toolActivityText('mcp__x__Bash', 'npm', tt)).toBe('正在处理…');
  });
});

describe('toolObject（后端挑宾语）', () => {
  it('Edit/Write/Read 取 file_path 的 basename', () => {
    expect(toolObject('Edit', { file_path: '/a/b/captureScheduler.ts' })).toBe('captureScheduler.ts');
    expect(toolObject('Write', { file_path: 'foo/bar.md' })).toBe('bar.md');
    expect(toolObject('Read', { file_path: 'x.ts' })).toBe('x.ts');
  });
  it('Grep 取 pattern、Bash 取命令首词、WebFetch 取 host', () => {
    expect(toolObject('Grep', { pattern: 'foo' })).toBe('foo');
    expect(toolObject('Bash', { command: 'npm run build' })).toBe('npm');
    expect(toolObject('WebFetch', { url: 'https://example.com/a/b' })).toBe('example.com');
  });
  it('未知工具 / 缺字段 / 非对象 input → undefined', () => {
    expect(toolObject('mcp__oru__view_slide', { x: 1 })).toBeUndefined();
    expect(toolObject('Edit', {})).toBeUndefined();
    expect(toolObject('Edit', null)).toBeUndefined();
    expect(toolObject('Edit', 'nope')).toBeUndefined();
  });
});

describe('toolActivityText（前端翻人话）', () => {
  it('已知工具带宾语 → 动词 + 宾语', () => {
    expect(toolActivityText('Edit', 'captureScheduler.ts', tt)).toBe('改 captureScheduler.ts');
    expect(toolActivityText('Grep', 'foo', tt)).toBe('搜 foo');
    expect(toolActivityText('Read', 'x.ts', tt)).toBe('读取 x.ts');
  });
  it('已知工具无宾语 → 正在<动词>', () => {
    expect(toolActivityText('Edit', undefined, tt)).toBe('正在改…');
  });
  it('未知工具不露代号 → 通用兜底', () => {
    expect(toolActivityText('mcp__oru__view_slide', undefined, tt)).toBe('正在处理…');
  });
});

describe('shorten', () => {
  it('超长截断到 max、带省略号、压平空白', () => {
    expect(shorten('a'.repeat(100)).length).toBe(80);
    expect(shorten('foo   bar\n baz')).toBe('foo bar baz');
  });
  it('短文本原样', () => {
    expect(shorten('hi')).toBe('hi');
  });
});
