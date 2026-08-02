/**
 * 崩溃盘记交还通路的路由层回归：
 * - conv.history（对话打开）→ 若有待交还盘记，广播 chat.steering.recovered（预填草稿，复用 Esc 退回形态）。
 * - chat.steering.recoverAck（前端并入草稿后的送达确认）→ 盘记清除，再打开不再交还。
 * 模块单测证不了 handler 接线（漏广播 / 漏清除路由层才看得见），故走真 route()。
 *
 * ORU_DIR 范式：顶层先设 env，route / 被测模块全动态 import。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerEvent } from '@shared/protocol';

const ORU_DIR = join(tmpdir(), `oru-test-steering-recover-route-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('conv.history 交还 + recoverAck 清除', () => {
  it('打开对话送达待交还文本；ack 后盘记清除、再打开不再交还', async () => {
    const agentId = 'agt-recover';
    const convId = 'cnv-recover';
    // 造「上次进程崩溃残留」：直接写 pending 盘记，再走启动扫描（真实重启路径）
    const { fileSteeringBackup, scanSteeringBackupsOnBoot } = await import(
      '../../electron/main/agent/steeringBackup'
    );
    await fileSteeringBackup.save(`${agentId}:${convId}`, [
      { clientMsgId: 'a', serverId: 's1', text: '崩溃前排队的话' },
    ]);
    await scanSteeringBackupsOnBoot();

    const { route } = await import('../../electron/main/ws/router');
    const events: ServerEvent[] = [];
    const collect = (ev: ServerEvent) => events.push(ev);

    // 对话打开（前端拉历史）→ 广播交还事件
    await route(
      { type: 'conv.history', reqId: 'h1', agentId, conversationId: convId },
      () => {},
      collect,
    );
    const recoveredEv = events.find((e) => e.type === 'chat.steering.recovered');
    // S08：交还事件带 SteeringMsg 投影 items（非纯 texts）；本条无 trigger 的旧残留经启动扫描
    // 兼容补 'user' → handbackForm 判 'draft' 回填草稿。
    expect(recoveredEv).toMatchObject({
      agentId,
      conversationId: convId,
      items: [{ text: '崩溃前排队的话', trigger: 'user' }],
    });

    // 送达确认 → 盘记清除
    await route(
      { type: 'chat.steering.recoverAck', reqId: 'k1', agentId, conversationId: convId },
      () => {},
      collect,
    );
    const recoveredFile = join(
      ORU_DIR, 'users', 'local-user', 'conversations', agentId,
      `${convId}.steering-recovered.json`,
    );
    expect(existsSync(recoveredFile)).toBe(false);

    // 再打开：不再交还（交还即清，不重复）
    const eventsAfter: ServerEvent[] = [];
    await route(
      { type: 'conv.history', reqId: 'h2', agentId, conversationId: convId },
      () => {},
      (ev: ServerEvent) => eventsAfter.push(ev),
    );
    expect(eventsAfter.find((e) => e.type === 'chat.steering.recovered')).toBeUndefined();
  });

  it('无盘记的对话打开不广播交还事件', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const events: ServerEvent[] = [];
    await route(
      { type: 'conv.history', reqId: 'h3', agentId: 'agt-clean', conversationId: 'cnv-clean' },
      () => {},
      (ev: ServerEvent) => events.push(ev),
    );
    expect(events.find((e) => e.type === 'chat.steering.recovered')).toBeUndefined();
  });
});
