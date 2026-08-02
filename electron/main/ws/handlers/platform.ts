/**
 * platform.* 命令处理器（D2(a) 迁移域）——三方平台接入（设置页「平台连接」）。
 * 行为与原 router.ts switch 内 platform.* 各 case 字节级一致；两个仅本域用的模块级
 * helper 随之内迁为文件内本地函数。handler 比 router 深一层目录，相对动态 import 多一层 `../`。
 */
import { ErrorCodes } from '@shared/types';
import type { ServerEventPayload } from '@shared/protocol';
import type { RegistrySlice } from './types';

/** 组装设置页「平台连接」的配置快照（凭证只回「是否已配置」布尔，红线 1 绝不回密文）。 */
async function buildPlatformConfigEvent(): Promise<ServerEventPayload> {
  const { getPlatformSettings } = await import('../../platform/platformSettings');
  const { hasCredential, getFeishuCredential } = await import('../../platform/credentialStore');
  const { getUserToken } = await import('../../platform/feishuUserToken');
  const { platformManager } = await import('../../platform/platformManager');
  const ps = await getPlatformSettings();
  // 用户授权状态：token 在且属于当前应用即算已授权（布尔 + 昵称元数据，密文不出主进程）
  const cred = await getFeishuCredential();
  const userToken = cred ? await getUserToken(cred.appId) : null;
  return {
    type: 'platform.config',
    config: {
      remoteDefaultAgentId: ps.remoteDefaultAgentId,
      whitelist: ps.whitelist,
      feishuEnabled: ps.feishuEnabled === true,
      discordEnabled: ps.discordEnabled === true,
      feishuConfigured: await hasCredential('feishu'),
      discordConfigured: await hasCredential('discord'),
      feishuUserAuthorized: userToken !== null,
      ...(userToken?.userName ? { feishuUserName: userToken.userName } : {}),
      statuses: platformManager.getStatus(),
    },
  };
}

/** 凭证 / 启用变更后让 platformManager 据新配置对齐连接（状态变化经 onStatus → broadcast 推渲染进程）。 */
async function reconcileAndBroadcastPlatforms(): Promise<void> {
  // 连接失败不应让「配置写入」的响应失败 / 挂起——失败状态另经 onStatus 推 UI（Minor: reply 必达）。
  try {
    const { platformManager } = await import('../../platform/platformManager');
    await platformManager.reconcile();
  } catch (e) {
    console.warn('[oru.platform] reconcile failed:', e);
  }
}

export const platformHandlers = {
  'platform.getConfig': async (req, { reply }) => {
    reply(req.reqId, await buildPlatformConfigEvent());
  },
  'platform.setCredential': async (req, { reply }) => {
    const { setFeishuCredential, setDiscordCredential } = await import('../../platform/credentialStore');
    if (req.platform === 'feishu' && req.appId && req.appSecret) {
      const cred = { appId: req.appId, appSecret: req.appSecret };
      await setFeishuCredential(cred);
      // 自动配 CLI（应用身份、secret 走 stdin）——后台跑，不阻塞保存回复（npx 首拉可能慢）；
      // 配好与否由「检查」按钮的 doctor 反映（§A：自动配 → 点检查全绿）。
      void import('../../platform/feishuSetup')
        .then((m) => m.configFeishuFromCredential(cred))
        .catch((e) => console.warn('[feishu] 自动 config init 失败（可点检查重试）:', e));
    } else if (req.platform === 'discord' && req.botToken) {
      await setDiscordCredential({ botToken: req.botToken });
    } else {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: '凭证字段不完整' });
      return;
    }
    await reconcileAndBroadcastPlatforms();
    reply(req.reqId, await buildPlatformConfigEvent());
  },
  'platform.clearCredential': async (req, { reply }) => {
    const { clearCredential } = await import('../../platform/credentialStore');
    const { clearWhitelistForPlatform } = await import('../../platform/platformSettings');
    await clearCredential(req.platform);
    // 换/解绑应用即作废该平台绑定的人（union_id/chatId 随应用变）——一并清白名单，让人在新应用下重配对。
    await clearWhitelistForPlatform(req.platform);
    if (req.platform === 'feishu') {
      // 应用凭证作废 → user token（其签发对象就是旧应用）同步作废，进行中的授权 flow 一并顶掉
      const { userAuthFlow } = await import('../../platform/feishuUserAuth');
      await userAuthFlow.revoke();
    }
    await reconcileAndBroadcastPlatforms();
    reply(req.reqId, await buildPlatformConfigEvent());
  },
  'platform.setEnabled': async (req, { reply }) => {
    const { setPlatformEnabled } = await import('../../platform/platformSettings');
    await setPlatformEnabled(req.platform, req.enabled);
    await reconcileAndBroadcastPlatforms();
    reply(req.reqId, await buildPlatformConfigEvent());
  },
  'platform.setRemoteAgent': async (req, { reply }) => {
    const { setRemoteAgentId } = await import('../../platform/platformSettings');
    await setRemoteAgentId(req.agentId);
    reply(req.reqId, await buildPlatformConfigEvent());
  },
  'platform.removeFromWhitelist': async (req, { reply }) => {
    const { mutateWhitelist } = await import('../../platform/platformSettings');
    await mutateWhitelist((list) => list.filter((x) => x.id !== req.id)); // 原子 RMW，防与绑定并发丢更新
    reply(req.reqId, await buildPlatformConfigEvent());
  },
  'platform.addToWhitelist': async (req, { reply }) => {
    const id = req.id.trim();
    if (!id) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: '用户 ID 不能为空' });
      return;
    }
    // 手动条目昵称留空——手动入口是批量/调试用，用户粘的是裸 ID 自知其人，界面显示 ID 即可（配对绑定才抓昵称）。
    // addToWhitelist 原子 RMW：已存在同 id 幂等跳过、不覆盖已抓到的昵称。
    const { addToWhitelist } = await import('../../platform/platformSettings');
    await addToWhitelist({ id, platform: req.platform, source: 'manual', boundAt: Date.now() });
    reply(req.reqId, await buildPlatformConfigEvent());
  },
  'platform.issuePairingCode': async (req, { reply }) => {
    const { platformManager } = await import('../../platform/platformManager');
    const { code, expiresAt } = platformManager.issuePairingCode();
    reply(req.reqId, { type: 'platform.pairingCode', code, expiresAt });
  },
  'platform.feishuScopeLink': async (req, { reply }) => {
    const { getFeishuCredential } = await import('../../platform/credentialStore');
    const cred = await getFeishuCredential();
    if (!cred) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: '先填飞书 App ID / Secret' });
      return;
    }
    const { resolveScopeSetup } = await import('../../platform/feishuScope');
    const { link, scopes } = await resolveScopeSetup(cred.appId);
    reply(req.reqId, { type: 'platform.scopeLink', link, scopes });
  },
  'platform.doctor': async (req, { reply }) => {
    const { getFeishuCredential } = await import('../../platform/credentialStore');
    const cred = await getFeishuCredential();
    if (!cred) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: '先填飞书 App ID / Secret' });
      return;
    }
    const { runDoctor } = await import('../../platform/feishuSetup');
    const { getRequiredScopes, checkAppScopes, buildScopeAuthLink } = await import('../../platform/feishuScope');
    const doctor = await runDoctor();
    // 校验所需 scope 是否在应用开通；缺啥给「点这申请」直达链接（只含缺的那些）。
    // 查不了（error 态）时 missing 为空 → 不生成误导性的申请链接。
    const required = await getRequiredScopes();
    const scopeCheck = await checkAppScopes(required);
    const applyLink = scopeCheck.missing.length ? buildScopeAuthLink(cred.appId, scopeCheck.missing) : undefined;
    reply(req.reqId, { type: 'platform.doctorResult', doctor, scopeCheck, applyLink });
  },
  // ─── 飞书用户授权（S5 · device flow）——状态机是 feishuUserAuth.ts 的 userAuthFlow 单例，
  // 迁移经 subscribe → broadcast 主动推（index.ts 接线）；这里只回当前快照。
  'platform.feishuUserAuthStart': async (req, { reply }) => {
    const { userAuthFlow } = await import('../../platform/feishuUserAuth');
    reply(req.reqId, { type: 'platform.feishuUserAuth', state: await userAuthFlow.start() });
  },
  'platform.feishuUserAuthCancel': async (req, { reply }) => {
    const { userAuthFlow } = await import('../../platform/feishuUserAuth');
    reply(req.reqId, { type: 'platform.feishuUserAuth', state: await userAuthFlow.cancel() });
  },
  'platform.feishuUserAuthRevoke': async (req, { reply }) => {
    const { userAuthFlow } = await import('../../platform/feishuUserAuth');
    await userAuthFlow.revoke();
    reply(req.reqId, await buildPlatformConfigEvent());
  },
  'platform.feishuUserAuthSendLink': async (req, { reply }) => {
    const { userAuthFlow } = await import('../../platform/feishuUserAuth');
    const state = userAuthFlow.getState();
    if (state.phase !== 'pending') {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: '先发起授权，再把链接发到飞书' });
      return;
    }
    // 发到已绑定飞书用户的私聊（绑定时捕获的 chatId）；没绑定过就没有可投的地址
    const { getPlatformSettings } = await import('../../platform/platformSettings');
    const target = (await getPlatformSettings()).whitelist.find(
      (w) => (w.platform === 'feishu' || w.platform === undefined) && w.chatId,
    );
    if (!target?.chatId) {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.UNKNOWN,
        message: '还没有已绑定的飞书用户——先在飞书里给 Oru 发一条消息完成绑定，或手动复制链接',
      });
      return;
    }
    const { deliverToChannel } = await import('../../platform/outbound');
    const { getSettings } = await import('../../projects/store');
    const { resolveEffectiveLang } = await import('../../i18n/effectiveLang');
    const { t } = await import('../../i18n/t');
    const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
    const text = t('main:platform.userAuthLink', lang, {
      link: state.verificationUriComplete,
      code: state.userCode,
      minutes: Math.max(1, Math.round((state.expiresAt - Date.now()) / 60000)),
    });
    const res = await deliverToChannel({ platform: 'feishu', chatId: target.chatId }, text);
    if (!res.ok) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: `发送到飞书失败：${res.error ?? '未知错误'}` });
      return;
    }
    reply(req.reqId, { type: 'platform.feishuUserAuth', state });
  },
} satisfies RegistrySlice;
