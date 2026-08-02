/**
 * grants.* 命令处理器（S24 · G30）——「已授权清单」的读取、写入与撤销。
 * 这是「始终允许」持久授权的唯一可见/可撤销后端面：list 拉全量；revoke 撤一条后回最新全量；
 * add 是设置页策略表拨杆「开→免卡」的写口（2026-07-30 决策 3，语义对齐卡上「始终允许」——
 * 卡上那条路径仍由 settleApprovalDecision 写入，两个入口同落 addGrant 单源、label 同经注册表
 * 按 owner 语言推导）。写/撤后都回最新全量清单（前端直接拿新列表刷新，省一次 round-trip）。
 * 有意不校验当前挡位：置灰是「表只定义工作挡」的呈现语义而非安全边界——只读挡硬拒先于
 * isGranted、危险挡本就全放，授权在哪挡写入都不改变那两挡的行为。
 */
import type { RegistrySlice } from './types';
import { rowForScope } from '@shared/proposals/behaviors';
import { addGrant, listGrants, revokeGrant } from '../../proposals/grants/store';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { getSettings } from '../../projects/store';
import { t } from '../../i18n/t';

export const grantHandlers = {
  'grants.list': async (req, { reply }) => {
    reply(req.reqId, { type: 'grants.list.result', grants: await listGrants() });
  },
  'grants.add': async (req, { reply }) => {
    const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
    // label 与 settle 烘焙同词同语：整类取注册表行标题；delivery 无提案上下文，回落 渠道:收件人
    const row = rowForScope(req.scope);
    const label =
      req.scope.kind === 'delivery'
        ? t('proposal:grant.deliveryTo', lang, { target: `${req.scope.channel}:${req.scope.recipient}` })
        : row
          ? t(`proposal:${row.titleKey}`, lang)
          : '';
    const r = await addGrant(req.scope, label);
    // persisted:false（写盘失败 / 非法 scope）如实回执——不假装持久成功（同 settle 口径）
    reply(req.reqId, {
      type: 'grants.list.result',
      grants: await listGrants(),
      ...(r.persisted ? {} : { grantPersistFailed: true }),
    });
  },
  'grants.revoke': async (req, { reply }) => {
    await revokeGrant(req.key);
    // 撤销后回最新全量清单：前端据此刷新，无需再发一次 grants.list。
    reply(req.reqId, { type: 'grants.list.result', grants: await listGrants() });
  },
} satisfies RegistrySlice;
