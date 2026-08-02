/**
 * 飞书「处理中」表情纯 helper（tech design §B）——给收到的消息贴 OnIt 表情、完成时移除 Oru 贴的全部表情。
 *
 * 承重逻辑（值得单测，区别于纯 SDK glue 的 send）：
 * - addOnItReaction 取回 reaction_id 供后续精确删除；贴失败返回 null（不崩 turn，表情只是锦上添花）。
 * - removeReactions 逐个删 Oru 自己加的 reaction，单个删失败不影响其余（尽力清干净）。
 *
 * 用 Pick<ReactionApi> 的最小 fake（satisfies，CLAUDE.md）测，不起真长连接。
 */
import { describe, expect, it, vi } from 'vitest';
import { addOnItReaction, removeReactions, type ReactionApi } from '../../electron/main/platform/feishu/reaction';

/** 最小 reaction client：只实现 helper 用到的 create / delete（Pick 透传真实 SDK 类型）。 */
function fakeApi(over: Partial<Pick<ReactionApi, 'create' | 'delete'>> = {}) {
  return {
    create: vi.fn(async () => ({ data: { reaction_id: 'r_1' } })),
    delete: vi.fn(async () => ({})),
    ...over,
  } satisfies Pick<ReactionApi, 'create' | 'delete'>;
}

describe('addOnItReaction', () => {
  it('贴 OnIt 表情并取回 reaction_id', async () => {
    const api = fakeApi();
    const id = await addOnItReaction(api, 'om_1');
    expect(id).toBe('r_1');
    expect(api.create).toHaveBeenCalledWith({
      path: { message_id: 'om_1' },
      data: { reaction_type: { emoji_type: 'OnIt' } },
    });
  });

  it('贴失败返回 null（不抛、不崩 turn）', async () => {
    const api = fakeApi({ create: vi.fn(async () => { throw new Error('no_permission'); }) });
    await expect(addOnItReaction(api, 'om_1')).resolves.toBeNull();
  });

  it('返回体无 reaction_id 时返回 null', async () => {
    const api = fakeApi({ create: vi.fn(async () => ({ data: {} })) });
    await expect(addOnItReaction(api, 'om_1')).resolves.toBeNull();
  });
});

describe('removeReactions', () => {
  it('逐个删传入的 reaction_id', async () => {
    const api = fakeApi();
    await removeReactions(api, 'om_1', ['r_1', 'r_2']);
    expect(api.delete).toHaveBeenCalledTimes(2);
    expect(api.delete).toHaveBeenCalledWith({ path: { message_id: 'om_1', reaction_id: 'r_1' } });
    expect(api.delete).toHaveBeenCalledWith({ path: { message_id: 'om_1', reaction_id: 'r_2' } });
  });

  it('单个删失败不影响其余（尽力清干净）', async () => {
    const delete_ = vi
      .fn<Pick<ReactionApi, 'delete'>['delete']>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({});
    const api = fakeApi({ delete: delete_ });
    await expect(removeReactions(api, 'om_1', ['r_bad', 'r_ok'])).resolves.toBeUndefined();
    expect(delete_).toHaveBeenCalledTimes(2);
  });

  it('空列表 no-op', async () => {
    const api = fakeApi();
    await removeReactions(api, 'om_1', []);
    expect(api.delete).not.toHaveBeenCalled();
  });
});
