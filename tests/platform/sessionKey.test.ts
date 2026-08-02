/**
 * sessionKey 确定性（tech design §4.1）——同一来源永远算出同一 key，不同平台 / 不同 chat 不撞。
 * 它是去重表、串行队列、get-or-create 锁三处的共同主键，必须确定且唯一。
 */
import { describe, expect, it } from 'vitest';
import { sessionKey } from '../../electron/main/platform/sessionKey';
import type { SessionSource } from '@shared/platform/message';

const src = (over: Partial<SessionSource> = {}): SessionSource => ({
  platform: 'feishu',
  chatId: 'oc_abc',
  chatType: 'dm',
  userId: 'ou_1',
  raw: {},
  ...over,
});

describe('sessionKey', () => {
  it('同一来源确定性：同输入同输出', () => {
    expect(sessionKey(src())).toBe(sessionKey(src()));
  });

  it('格式带平台前缀与 chatId', () => {
    expect(sessionKey(src())).toBe('oru:feishu:dm:oc_abc');
  });

  it('不同平台不撞（chatId 相同也分得开）', () => {
    expect(sessionKey(src({ platform: 'feishu' }))).not.toBe(sessionKey(src({ platform: 'discord' })));
  });

  it('不同 chat 不撞', () => {
    expect(sessionKey(src({ chatId: 'a' }))).not.toBe(sessionKey(src({ chatId: 'b' })));
  });

  it('key 不掺入 userId（DM 里 chat 即身份，掺 userId 会让同一会话算出两个 key）', () => {
    expect(sessionKey(src({ userId: 'x' }))).toBe(sessionKey(src({ userId: 'y' })));
  });
});
