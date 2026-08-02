/**
 * platformManager（tech design §1 总装）——主进程侧的三方平台生命周期管理：
 * 开机 / 配置变更时据 Settings.platforms 把启用且已配置凭证的平台连上长连接，单实例锁保证同一
 * App 只一条连接（红线 4，可接管），停机 / 禁用时清干净（disconnect + 释放锁，副作用纪律）。
 *
 * 配对码（PairingManager）由本管理器持有——桌面设置点「生成配对码」走 issuePairingCode；
 * 平台侧绑定经 gateway 的 access 决策消费它。状态经 onStatus 推给 WS 层 → 渲染进程实时显示。
 *
 * 凭证从 credentialStore 取（主进程独有，红线 1），绝不经渲染进程 / config.json。
 */
import { join } from 'node:path';
import type { Platform, PlatformConnState, PlatformStatus } from '@shared/platform/message';
import type { ServerEvent } from '@shared/protocol';
import { userDir } from '../runtime/paths';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { FeishuAdapter } from './feishu/adapter';
import { DiscordAdapter } from './discord/adapter';
import type { PlatformAdapter } from './adapter';
import { createPlatformGateway } from './gatewayWiring';
import { registerChannelSender, unregisterChannelSender } from './outbound';
import { registerApprovalProjector, unregisterApprovalProjector } from './approvalProjection';
import { PairingManager } from './pairing';
import { acquireSingleInstance } from './singleInstanceLock';
import { getFeishuCredential, getDiscordCredential } from './credentialStore';
import { loadWhitelist, addToWhitelist, backfillWhitelistChatId, resolveRemoteAgentId, getPlatformSettings } from './platformSettings';

interface LiveConn {
  adapter: PlatformAdapter;
  release: () => void;
}

export class PlatformManager {
  private readonly pairing = new PairingManager({ now: () => Date.now() });
  private readonly conns = new Map<Platform, LiveConn>();
  private readonly status = new Map<Platform, PlatformStatus>();
  private readonly listeners = new Set<(s: PlatformStatus) => void>();
  /** 会话变更监听器（§4.5）——平台 turn 通知「某 agent 会话变了」，WS 层据此广播 conv.state。 */
  private readonly convListeners = new Set<(agentId: string) => void>();
  /** 全局广播器（WS 层注入）——平台 turn 据此把 chat.* 推给桌面；未注入则平台 turn 不实时刷桌面。 */
  private broadcaster: ((ev: ServerEvent) => void) | null = null;
  /** 正在 reconcile 的平台——挡住并发 reconcile（连点启用/保存凭证）双重连接 / 重复持锁。 */
  private readonly reconciling = new Set<Platform>();

  /** 桌面设置生成一次性配对码（显示给用户，平台侧发回完成绑定）。 */
  issuePairingCode(): { code: string; expiresAt: number } {
    return this.pairing.issue();
  }

  onStatus(cb: (s: PlatformStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 订阅会话变更（§4.5，对称 onStatus）——WS 层订阅后把 agentId 广播成 conv.state。 */
  onConvChanged(cb: (agentId: string) => void): () => void {
    this.convListeners.add(cb);
    return () => this.convListeners.delete(cb);
  }

  /** 注入全局广播器（WS 层装配时调一次）——平台 turn 的 chat.* 经它推达桌面。 */
  setBroadcaster(fn: (ev: ServerEvent) => void): void {
    this.broadcaster = fn;
  }

  private emitConvChanged(agentId: string): void {
    for (const cb of this.convListeners) cb(agentId);
  }

  getStatus(): PlatformStatus[] {
    return [...this.status.values()];
  }

  private setStatus(platform: Platform, state: PlatformConnState, error?: string): void {
    const s: PlatformStatus = { platform, state, error };
    this.status.set(platform, s);
    for (const cb of this.listeners) cb(s);
  }

  /** 据当前 Settings + 凭证对齐：启用且已配置 → 连；禁用 / 无凭证 → 断。开机与配置变更都调它。 */
  async reconcile(): Promise<void> {
    const settings = await getPlatformSettings();
    await this.reconcileOne('feishu', settings.feishuEnabled === true, async () => {
      const c = await getFeishuCredential();
      return c ? new FeishuAdapter(c) : null;
    });
    await this.reconcileOne('discord', settings.discordEnabled === true, async () => {
      const c = await getDiscordCredential();
      return c ? new DiscordAdapter(c) : null;
    });
  }

  /**
   * 单平台对齐（飞书 / Discord 共用——「加第二个平台零成本」）。差异只在 makeAdapter（凭证 + adapter 构造），
   * 连接编排（并发 guard、单实例锁、gateway 装配、状态机）完全一致。
   */
  private async reconcileOne(
    platform: Platform,
    enabled: boolean,
    makeAdapter: () => Promise<PlatformAdapter | null>,
  ): Promise<void> {
    if (this.reconciling.has(platform)) return; // 并发 reconcile 串行化（连点防双连）
    this.reconciling.add(platform);
    try {
      if (!enabled) {
        await this.disconnectOne(platform);
        this.setStatus(platform, 'disconnected');
        return;
      }
      if (this.conns.has(platform)) return; // 已连
      const adapter = await makeAdapter();
      if (!adapter) {
        this.setStatus(platform, 'not-configured');
        return;
      }
      this.setStatus(platform, 'connecting');
      const lock = acquireSingleInstance(join(userDir(getCurrentOwnerId()), `platform-${platform}.lock`));
      if (!lock.acquired) {
        this.setStatus(platform, 'held-by-other');
        return; // 单实例红线 4：另一实例已持有连接
      }
      const gateway = createPlatformGateway(adapter, {
        pairing: this.pairing,
        loadWhitelist,
        addToWhitelist,
        backfillChatId: backfillWhitelistChatId,
        resolveRemoteAgentId,
        notifyConvChanged: (agentId) => this.emitConvChanged(agentId),
        // 走存取器读最新 broadcaster——setBroadcaster 可能晚于本次 reconcile 注入，闭包捕获实例即可。
        broadcast: (ev) => this.broadcaster?.(ev),
      });
      try {
        await adapter.connect((e) => gateway.handleMessage(e));
        this.conns.set(platform, { adapter, release: lock.release });
        // 注册出站发送器（S10）：统一回合装配的 deliverToChannel 据平台从此表取（回发对「谁起的回合」
        // 不敏感）。与 disconnect 的 unregister 成对（副作用纪律）。
        registerChannelSender(platform, (chatId, text) => adapter.send(chatId, text));
        // 注册审批投影器（S24 · G30）：channelOutbound 据 approvalCapability 分流，
        // settleApprovalDecision 据登记的方法把渠道投影卡刷成终态。与 disconnect 的 unregister 成对。
        registerApprovalProjector(platform, {
          capability: adapter.approvalCapability,
          sendApprovalCard: adapter.sendApprovalCard?.bind(adapter),
          updateApprovalCardToTerminal: adapter.updateApprovalCardToTerminal?.bind(adapter),
        });
        this.setStatus(platform, 'connected');
      } catch (e) {
        lock.release();
        this.setStatus(platform, 'credential-error', String(e));
      }
    } finally {
      this.reconciling.delete(platform);
    }
  }

  private async disconnectOne(platform: Platform): Promise<void> {
    const conn = this.conns.get(platform);
    if (!conn) return;
    this.conns.delete(platform);
    unregisterChannelSender(platform); // 与 registerChannelSender 成对（回发发送器随连接生灭）
    unregisterApprovalProjector(platform); // 与 registerApprovalProjector 成对（S24 投影器随连接生灭）
    await conn.adapter.disconnect();
    conn.release(); // 释放单实例锁
  }

  /** 停机：断所有连接、释放锁、清心跳 + 状态监听（成对清理）。 */
  async stop(): Promise<void> {
    for (const platform of [...this.conns.keys()]) await this.disconnectOne(platform);
    this.listeners.clear();
    this.convListeners.clear();
  }
}

/** 进程级单例——index.ts 启动时 reconcile，WS 层用它发配对码 / 推状态。 */
export const platformManager = new PlatformManager();
