/**
 * 斜杠命令解析（command.ts）——跨平台同源解析、取参集中一处。
 * 承重：控制命令返回结构化 kind；/mode 带挡位参数（非法/缺失回 null，交 gateway 提示）；
 * 未知斜杠词不当命令（不误吞成能力/正文）。
 */
import { describe, expect, it } from 'vitest';
import { parseCommand } from '@shared/platform/command';

describe('parseCommand', () => {
  it('控制命令返回对应 kind', () => {
    expect(parseCommand('/stop')).toEqual({ kind: 'stop' });
    expect(parseCommand('/new')).toEqual({ kind: 'new' });
    expect(parseCommand('/compress')).toEqual({ kind: 'compress' });
  });

  it('大小写 / 前后空白不敏感', () => {
    expect(parseCommand('  /STOP  ')).toEqual({ kind: 'stop' });
    expect(parseCommand('/Mode Danger')).toEqual({ kind: 'setMode', mode: 'danger' });
  });

  it('/mode <挡位> 解析出三挡', () => {
    expect(parseCommand('/mode readonly')).toEqual({ kind: 'setMode', mode: 'readonly' });
    expect(parseCommand('/mode work')).toEqual({ kind: 'setMode', mode: 'work' });
    expect(parseCommand('/mode danger')).toEqual({ kind: 'setMode', mode: 'danger' });
  });

  it('/mode 参数缺失 / 非法 → setMode 且 mode: null（交 gateway 回用法）', () => {
    expect(parseCommand('/mode')).toEqual({ kind: 'setMode', mode: null });
    expect(parseCommand('/mode foo')).toEqual({ kind: 'setMode', mode: null });
  });

  it('非命令 / 未知斜杠词 → undefined（不误吞正文）', () => {
    expect(parseCommand('hello')).toBeUndefined();
    expect(parseCommand('把这个删了')).toBeUndefined();
    expect(parseCommand('/foobar')).toBeUndefined();
    expect(parseCommand('/danger')).toBeUndefined(); // 挡位必须走 /mode，裸 /danger 不是命令
  });

  it('/compact 是 /compress 的别名（解析层归一，下游无感）', () => {
    expect(parseCommand('/compact')).toEqual({ kind: 'compress' });
    expect(parseCommand('/Compact')).toEqual({ kind: 'compress' });
  });

  it('/status /help 无参控制命令', () => {
    expect(parseCommand('/status')).toEqual({ kind: 'status' });
    expect(parseCommand('/help')).toEqual({ kind: 'help' });
  });

  it('/model 无参 → index: null（列清单）', () => {
    expect(parseCommand('/model')).toEqual({ kind: 'model', index: null, invalid: false });
  });

  it('/model <编号> 解析出数字', () => {
    expect(parseCommand('/model 2')).toEqual({ kind: 'model', index: 2, invalid: false });
    expect(parseCommand('/MODEL 12')).toEqual({ kind: 'model', index: 12, invalid: false });
  });

  it('/model 参数非数字 → invalid: true（回用法，不静默列清单）', () => {
    expect(parseCommand('/model abc')).toEqual({ kind: 'model', index: null, invalid: true });
    expect(parseCommand('/model 2.5')).toEqual({ kind: 'model', index: null, invalid: true });
    expect(parseCommand('/model -1')).toEqual({ kind: 'model', index: null, invalid: true });
  });
});
