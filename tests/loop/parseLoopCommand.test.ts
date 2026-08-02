import { describe, it, expect } from 'vitest';
import { parseLoopCommand } from '@shared/loop/parseLoopCommand';

describe('parseLoopCommand', () => {
  it('以 /loop 开头 → 识别为 loop，剥掉命令前缀取目标', () => {
    expect(parseLoopCommand('/loop 把周报打磨到能发给投资人')).toEqual({
      isLoop: true,
      goal: '把周报打磨到能发给投资人',
    });
  });

  it('/loop 后多个空格也吃掉', () => {
    expect(parseLoopCommand('/loop    收紧措辞')).toEqual({ isLoop: true, goal: '收紧措辞' });
  });

  it('只打 /loop 不带目标 → isLoop 但 goal 为空（编排层据此回提示）', () => {
    expect(parseLoopCommand('/loop')).toEqual({ isLoop: true, goal: '' });
    expect(parseLoopCommand('/loop   ')).toEqual({ isLoop: true, goal: '' });
  });

  it('普通文本不以 /loop 开头 → 不是 loop', () => {
    expect(parseLoopCommand('帮我改改这段')).toEqual({ isLoop: false, goal: '帮我改改这段' });
  });

  it('/loopx 这类非边界前缀不误判（必须是 /loop 后接空白或结束）', () => {
    expect(parseLoopCommand('/loopback 配置')).toEqual({ isLoop: false, goal: '/loopback 配置' });
  });

  it('前导空白容忍：用户先敲了空格', () => {
    expect(parseLoopCommand('  /loop 干这个')).toEqual({ isLoop: true, goal: '干这个' });
  });
});
