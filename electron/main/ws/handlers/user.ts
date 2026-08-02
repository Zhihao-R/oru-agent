/**
 * user.* 命令处理器（D2(a) 迁移域）——行为与原 router.ts switch 内 user.profile.* 各 case 字节级一致，纯搬运。
 */
import { ErrorCodes } from '@shared/types';
import type { RegistrySlice } from './types';
import { getCurrentOwnerId } from '../../identity/getCurrentOwnerId';

export const userHandlers = {
  'user.profile.get': async (req, { reply }) => {
    const { getProfile } = await import('../../identity/profile');
    const profile = await getProfile(getCurrentOwnerId());
    reply(req.reqId, { type: 'user.profile.state', profile });
  },
  'user.profile.update': async (req, { reply, broadcast }) => {
    const { updateProfile, validateName, ProfileValidationError } = await import(
      '../../identity/profile'
    );
    const { saveUserAvatar } = await import('../../agent/store/avatar');
    const ownerId = getCurrentOwnerId();
    try {
      // 1. 先做纯内存校验（name 校验提前，避免写图成功后 name 失败留孤儿）
      if (req.patch.name !== undefined) validateName(req.patch.name);
      // 2. 写图（磁盘）
      const patch = { ...req.patch };
      if (req.newAvatarBase64Png) {
        patch.avatarPath = await saveUserAvatar(ownerId, req.newAvatarBase64Png);
      }
      // 3. 写 profile
      const profile = await updateProfile(ownerId, patch);
      reply(req.reqId, { type: 'user.profile.state', profile });
      // 广播给其他订阅者（不带 reqId）
      broadcast({ type: 'user.profile.state', profile });
    } catch (e) {
      if (e instanceof ProfileValidationError) {
        reply(req.reqId, {
          type: 'error',
          code: ErrorCodes.PROFILE_INVALID,
          message: e.message,
        });
        return;
      }
      throw e;
    }
  },
} satisfies RegistrySlice;
