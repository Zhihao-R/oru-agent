/**
 * 当前用户身份的统一入口
 *
 * MVP 阶段：永远返回 'local-user'（单用户模式）
 * 未来加多用户：在这一处接 OS 用户 / 账户系统 / etc，业务代码不动
 *
 * 所有 store 的读写、所有跟"数据归谁所有"相关的判断都应通过这个函数。
 */

export const LOCAL_USER_ID = 'local-user';

export function getCurrentOwnerId(): string {
  return LOCAL_USER_ID;
}
