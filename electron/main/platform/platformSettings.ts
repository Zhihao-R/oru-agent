/**
 * 平台非密配置访问器——白名单 / 远程默认 agent / 启用开关，落在 Settings.platforms（config.json）。
 * 凭证不经此（红线 1，见 credentialStore.ts）。为 gateway 的 PlatformRuntimeConfig 提供后端。
 * fail-closed：未配置时白名单空、远程 agent null。
 */
import type { PlatformSettings, WhitelistEntry } from '@shared/types';
import type { Platform } from '@shared/platform/message';
import { getSettings, updateSettings } from '../projects/store';

const EMPTY: PlatformSettings = { remoteDefaultAgentId: null, whitelist: [] };

/**
 * 白名单读时归一（迁移）：旧版本存裸字符串数组，新版存 WhitelistEntry。裸字符串 → `{ id }`
 * （平台/昵称/时间未知留空，界面回落显示 id）。无写盘迁移——下次 save 才落成新形，读侧始终兼容两形。
 */
function normalizeWhitelist(raw: unknown): WhitelistEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e): WhitelistEntry | null =>
      typeof e === 'string' ? { id: e } : e && typeof (e as WhitelistEntry).id === 'string' ? (e as WhitelistEntry) : null,
    )
    .filter((e): e is WhitelistEntry => e !== null);
}

async function current(): Promise<PlatformSettings> {
  const p = (await getSettings()).platforms ?? EMPTY;
  return { ...p, whitelist: normalizeWhitelist(p.whitelist as unknown) };
}

/** 整体写回（updateSettings 浅合并会整段覆盖 platforms，故 caller 传完整对象）。 */
async function patch(next: PlatformSettings): Promise<void> {
  await updateSettings({ platforms: next });
}

export async function loadWhitelist(): Promise<WhitelistEntry[]> {
  return (await current()).whitelist;
}

export async function saveWhitelist(list: WhitelistEntry[]): Promise<void> {
  await patch({ ...(await current()), whitelist: list });
}

/**
 * 原子改白名单（read-modify-write 整块入锁，防并发绑定/增删丢更新）——mutate 在锁内拿到最新列表再算。
 * 承重：白名单是 fail-closed 守门唯一依据，丢条目可能把已移除的人放回来 / 把新绑丢掉。
 */
export async function mutateWhitelist(mutate: (list: WhitelistEntry[]) => WhitelistEntry[]): Promise<void> {
  await updateSettings((s) => {
    const base = s.platforms ?? EMPTY;
    return { platforms: { ...base, whitelist: mutate(normalizeWhitelist((base as { whitelist?: unknown }).whitelist)) } };
  });
}

/** 原子往白名单追加一条（已存在同 id 则原样保留，不覆盖已抓到的昵称）。 */
export async function addToWhitelist(entry: WhitelistEntry): Promise<void> {
  await mutateWhitelist((list) => (list.some((e) => e.id === entry.id) ? list : [...list, entry]));
}

/**
 * 清掉某平台的全部白名单条目（换 / 解绑该平台应用时调）——白名单的 union_id/open_id/chatId 都随
 * 应用（开发者）作废，留着要么认不出人、要么地址失效且不自愈，故整批清、让人在新应用下重新配对。
 * 只清明确标了该平台的条目；平台未知的旧数据（无 platform 字段）保守留着，不误删别平台/legacy。
 */
export async function clearWhitelistForPlatform(platform: Platform): Promise<void> {
  await mutateWhitelist((list) => list.filter((e) => e.platform !== platform));
}

/**
 * 补录某认证用户的聊天地址（原子，只补缺失）——匹配 stableId 或裸 userId 的条目，仅当它还没 chatId
 * 时写入（供「定时任务按人推送」定位）。已有 chatId / 找不到条目：原样返回，不写盘（避免每条消息都写）。
 */
export async function backfillWhitelistChatId(id: string, userId: string, chatId: string): Promise<void> {
  await mutateWhitelist((list) =>
    list.map((e) => ((e.id === id || e.id === userId) && !e.chatId ? { ...e, chatId } : e)),
  );
}

export async function resolveRemoteAgentId(): Promise<string | null> {
  return (await current()).remoteDefaultAgentId;
}

export async function setRemoteAgentId(agentId: string | null): Promise<void> {
  await patch({ ...(await current()), remoteDefaultAgentId: agentId });
}

export async function getPlatformSettings(): Promise<PlatformSettings> {
  return current();
}

export async function setPlatformEnabled(platform: 'feishu' | 'discord', enabled: boolean): Promise<void> {
  const cur = await current();
  await patch(platform === 'feishu' ? { ...cur, feishuEnabled: enabled } : { ...cur, discordEnabled: enabled });
}
