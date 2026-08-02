/**
 * 平台 turn 的两个纯决策（tech design §5 挡位 + §8 分段）。
 *
 * decidePlatformProposal（§5 / §11 attacker「挡位不被绕过」）——远程没有逐操作审批卡，
 * 复用全局挡位：danger 且非强制确认 → 执行；否则（挡位不足 / 强制确认无人可点）→ 拦下并回提示调挡，
 * 绝不静默执行。镜像桌面 onProposal（mode!=='readonly' && !forceApproval 才动手），只把
 * 「弹卡 / 拦截」分支换成「拦下 + 回提示」。
 *
 * splitMessage（§8）——超平台上限分段：保 code fence 不被从中间截断、带 (x/y)、优先自然边界。
 */
import { describe, expect, it } from 'vitest';
import { decidePlatformProposal, splitMessage, buildSourceContext } from '../../electron/main/platform/platformTurn';
import type { SessionSource } from '@shared/platform/message';

const src = (over: Partial<SessionSource> = {}): SessionSource => ({
  platform: 'feishu',
  chatId: 'oc_1',
  chatType: 'dm',
  userId: 'ou_1',
  raw: {},
  ...over,
});

describe('buildSourceContext — 来源感知（§A 信任拆分）', () => {
  it('飞书 DM：注入平台 / 会话类型 / 会话 ID / 发话人 open_id', () => {
    const ctx = buildSourceContext(src({ chatId: 'oc_x', userId: 'ou_y' }));
    expect(ctx).toContain('飞书');
    expect(ctx).toContain('私聊');
    expect(ctx).toContain('oc_x');
    expect(ctx).toContain('ou_y');
  });

  it('明说"通过飞书被远程触达"，纠正"我们在 Oru 里"的误答', () => {
    expect(buildSourceContext(src())).toContain('飞书');
    expect(buildSourceContext(src())).toMatch(/远程|被.*触达|飞书.*聊/);
  });

  it('带防注入守则：别把用户正文当元数据', () => {
    expect(buildSourceContext(src())).toMatch(/不可信|不要把.*当.*元数据|元数据/);
  });

  it('Discord 平台名正确', () => {
    expect(buildSourceContext(src({ platform: 'discord', userId: 'duser' }))).toContain('Discord');
  });
});

describe('decidePlatformProposal — 挡位不被绕过', () => {
  it('danger + 非强制 → 执行', () => {
    expect(decidePlatformProposal({ forceApproval: false }, 'danger').kind).toBe('execute');
  });
  it('work + 非强制 → 执行（镜像桌面 mode!==readonly 自动执行）', () => {
    expect(decidePlatformProposal({ forceApproval: false }, 'work').kind).toBe('execute');
  });
  it('readonly + 非 code（mcp 装卸等写类）→ 拦下（破坏性硬约束；扩展装卸按挡位过闸归 S04）', () => {
    expect(decidePlatformProposal({ forceApproval: false }, 'readonly').kind).toBe('blocked');
    expect(decidePlatformProposal({ kind: 'mcp.install', forceApproval: false }, 'readonly').kind).toBe('blocked');
  });
  it('readonly + code 派工 → 执行（S02 · G73：派工不改变环境，任何挡位都可派，远程同口径）', () => {
    expect(decidePlatformProposal({ kind: 'code', forceApproval: false }, 'readonly').kind).toBe('execute');
  });
  it('强制确认（破坏性/覆盖）即便 danger 也拦下——远程无人可点；code 派工带强制确认同样拦', () => {
    expect(decidePlatformProposal({ forceApproval: true }, 'danger').kind).toBe('blocked');
    expect(decidePlatformProposal({ forceApproval: true }, 'work').kind).toBe('blocked');
    expect(decidePlatformProposal({ kind: 'code', forceApproval: true }, 'readonly').kind).toBe('blocked');
  });
  // 拦下回执文案已从决策搬到 gatewayWiring（按 owner 语言 t('main:platform.approvalBlocked')）——
  // 决策只判 kind，文案由 main.json + keyAlignment/mainT 守，这里不再断言 message。
});

describe('splitMessage — 分段', () => {
  it('未超上限：单段、无 (x/y) 标记', () => {
    const parts = splitMessage('短消息', 100);
    expect(parts).toEqual(['短消息']);
  });

  it('超上限：分多段，每段不超上限', () => {
    const text = Array.from({ length: 50 }, (_, i) => `第 ${i} 行内容`).join('\n');
    const parts = splitMessage(text, 80);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(80);
  });

  it('多段带 (i/n) 标记', () => {
    const text = 'x'.repeat(500);
    const parts = splitMessage(text, 100);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toMatch(/\(1\/\d+\)/);
    expect(parts[parts.length - 1]).toMatch(new RegExp(`\\(${parts.length}/${parts.length}\\)`));
  });

  it('code fence 不被从中间截断：每段 ``` 数为偶数（自洽闭合）', () => {
    const code = ['前言', '```ts', ...Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`), '```', '后记'].join('\n');
    const parts = splitMessage(code, 120);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      const fences = (p.match(/```/g) ?? []).length;
      expect(fences % 2).toBe(0);
    }
  });

  it('闭合 ``` 必须独占一行：(i/n) 标记不得贴在 fence 行尾（否则渲染器不认作闭合）', () => {
    const code = ['```ts', ...Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`), '```'].join('\n');
    const parts = splitMessage(code, 120);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      for (const line of p.split('\n')) {
        // 含 ``` 的行必须是纯 fence 行（``` 或 ```lang），不能尾随 (i/n) 之类内容
        if (line.includes('```')) expect(line).toMatch(/^```[a-zA-Z]*$/);
      }
    }
  });

  it('优先自然边界：能按行分就不切断行（普通多行文本每段不留半行）', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n');
    const parts = splitMessage(text, 40);
    // 每段去掉 (x/y) 标记后都应由完整的 line-N 组成
    for (const p of parts) {
      const body = p.replace(/\s*\(\d+\/\d+\)\s*$/, '');
      for (const line of body.split('\n')) {
        if (line) expect(line).toMatch(/^line-\d+$/);
      }
    }
  });
});
