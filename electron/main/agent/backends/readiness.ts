/**
 * 后端可用性前置检查（理想架构 S34 · G28，锚 conversation-flow.html#Backend）。
 *
 * 「后端可用?」是回合正式开始前的前置检查——与「回合跑到一半才断线」是两类失败：前者回合尚未
 * 开始、代价为零（历史与队列均无损），后者已有部分产出需续传或中止。故检查必须在起回合入口
 * 落盘 user 消息之前发生，而不是进了 runChatLocked 才探（那时 user 已进历史，失败非「无损」）。
 *
 * 单一事实源：chat.send 的回合开始前预检与 runChatLocked 的兜底检查都走这里，口径一致。
 */
import type { AuthStatus, LlmUsage } from '@shared/types';
import { getSettings } from '../../projects/store';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { t } from '../../i18n/t';
import { getBackendFor } from './factory';

/** 探一次目标用途的后端是否可用。ok=false 时 hint 是给用户的可读原因（未配置 / 鉴权失败 / 网络不通）。 */
export async function checkBackendReady(usage: LlmUsage): Promise<{ ok: boolean; hint: string }> {
  const backend = await getBackendFor(usage);
  return backend.isReady();
}

/**
 * UI 门禁口径（ws auth.status 的唯一事实源）：主对话（twinMain）此刻有没有可用的模型后端。
 *
 * 多 backend 时代，「不能聊」= 没有任何可用后端，而非「Claude 鉴权缺失」——用户配了
 * OpenRouter / coding plan 等任一路可用后端，就不该再被 Claude 登录提示拦。Claude 未登录
 * 只在它真是唯一出路（twinMain 未分配、走本机 OAuth 回落）时才出现在引导文案里。
 */
export async function mainChatStatus(): Promise<AuthStatus> {
  try {
    const res = await checkBackendReady('twinMain');
    if (res.ok) return { ready: true, hint: res.hint };
    // 未分配模型时实际走的是本机 Claude 回落，isReady 的 hint 是 Claude 中心的
    // （「请登录 Claude Code 或在设置里填入 API Key」）——改写成「配置供应商 / 登录 Claude」双路径引导。
    // 上屏文案按 owner 语言取词（主进程 i18n 约定；透传的后端 hint 是既有硬编码中文债，不在此修）。
    const settings = await getSettings();
    if (!settings.modelAssignments.twinMain) {
      return {
        ready: false,
        hint: t('main:backend.noUsableBackend', resolveEffectiveLang(settings.language)),
      };
    }
    return { ready: false, hint: res.hint };
  } catch (e) {
    // 构造期异常（如 custom-openai 缺 baseUrl）与 isReady 的 ok:false 同口径收敛
    return { ready: false, hint: e instanceof Error ? e.message : String(e) };
  }
}
