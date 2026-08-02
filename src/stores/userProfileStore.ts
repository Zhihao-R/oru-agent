/**
 * 用户自己的 profile（名字 + 头像）store
 *
 * 跟 agentStore 同模式：
 *  - refresh() 主动 fetch
 *  - syncFromServer() 处理广播
 *  - update() 调 user.profile.update（可带 newAvatarBase64Png 原子提交）
 */
import { create } from 'zustand';
import type { UserProfile } from '@shared/types';
import type { UserProfileStateEvent, UserProfileUpdateReq } from '@shared/protocol';
import { wsClient } from '@/lib/ws';

type UserProfileStoreState = {
  profile: UserProfile | null;
  syncFromServer: (profile: UserProfile) => void;
  refresh: () => Promise<void>;
  /** 调 user.profile.update；patch + 可选的新头像 base64Png 原子提交 */
  update: (
    args: Pick<UserProfileUpdateReq, 'patch' | 'newAvatarBase64Png'>,
  ) => Promise<UserProfile>;
};

export const useUserProfileStore = create<UserProfileStoreState>((set) => ({
  profile: null,
  syncFromServer: (profile) => set({ profile }),
  async refresh() {
    try {
      const res = await wsClient.request<UserProfileStateEvent>({ type: 'user.profile.get' });
      if (res.type === 'user.profile.state') {
        set({ profile: res.profile });
      }
    } catch {
      // ignore — 主进程未启动 / 网络故障；UI 层走 fallback 默认值
    }
  },
  async update({ patch, newAvatarBase64Png }) {
    const res = await wsClient.request<UserProfileStateEvent>({
      type: 'user.profile.update',
      patch,
      ...(newAvatarBase64Png ? { newAvatarBase64Png } : {}),
    });
    // res 可能是 error，wsClient.request 会 throw
    if (res.type === 'user.profile.state') {
      set({ profile: res.profile });
      return res.profile;
    }
    throw new Error(`unexpected response: ${res.type}`);
  },
}));
