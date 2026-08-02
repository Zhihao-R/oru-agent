/**
 * 留作长期排障工具（2026-07-13 清理审计确认保留）：唯一不启动整个应用即可验证真凭证连通性的入口。
 * 飞书 adapter 长连接收发——真机一次性验证（第一里程碑「飞书 adapter 长连接收发跑通」）。
 *
 * 直接用生产 FeishuAdapter 跑真长连接：建连 → 收私聊 DM（经真实 normalize 打印）→ echo 回发，
 * 一次跑完即验证「收 + 发」整条链路，无需先启动整个 Electron app。
 *
 * 凭证安全（红线 1）：App Secret 经 **stdin** 读入（不进 env / 不进命令行 argv / 不落日志）。
 *
 * 前置（你在飞书开放平台后台先配好，App = 同一个）：
 *   ① 应用能力加「机器人」；② 事件订阅选「长连接」模式；③ 订阅 im.message.receive_v1；
 *   ④ 申请并发布 im:message（收）+ im:message:send_as_bot（回）scope。
 *
 * 用法（交互粘贴 secret，避免进 shell 历史）：
 *   npx tsx --tsconfig tsconfig.node.json scripts/feishuConnCheck.ts <APP_ID>
 *   # 运行后粘贴 App Secret，回车，按 Ctrl-D 结束输入；随后在飞书私聊 bot 发消息
 */
import { FeishuAdapter } from '../electron/main/platform/feishu/adapter';

const WINDOW_MS = 90_000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf-8').trim();
}

async function main(): Promise<void> {
  const appId = process.argv[2];
  if (!appId) {
    console.error('用法: npx tsx --tsconfig tsconfig.node.json scripts/feishuConnCheck.ts <APP_ID>（随后从 stdin 粘贴 App Secret）');
    process.exit(1);
  }
  console.error('请粘贴 App Secret，回车后按 Ctrl-D：');
  const appSecret = await readStdin();
  if (!appSecret) {
    console.error('未从 stdin 读到 App Secret');
    process.exit(1);
  }

  const adapter = new FeishuAdapter({ appId, appSecret });
  let received = 0;
  console.log('正在建立飞书长连接…');
  const ok = await adapter.connect(async (e) => {
    received += 1;
    // 不打印 raw（可能含敏感体）；只打印 normalize 出的承重字段
    console.log(`\n✅ 收到 DM #${received}: text=${JSON.stringify(e.text)} chatId=${e.source.chatId} userId=${e.source.userId} cmd=${e.command ?? '-'}`);
    const r = await adapter.send(e.source.chatId, `（adapter 连通性回声）你发了：${e.text}`);
    console.log(`   ↩ 回发: ${r.ok ? '成功 messageId=' + r.messageId : '失败 ' + r.error}`);
  });
  if (!ok) {
    console.error('❌ 长连接建立失败');
    process.exit(1);
  }
  console.log(`✅ 长连接已建立。请在飞书私聊该 bot 发一条消息（${WINDOW_MS / 1000}s 窗口）…`);

  setTimeout(() => {
    console.log(`\n窗口结束，共收到 ${received} 条消息${received > 0 ? '——adapter 长连接收发跑通 ✅' : '（未收到：检查后台事件订阅是否选了「长连接」并订阅 im.message.receive_v1）'}`);
    void adapter.disconnect().finally(() => process.exit(0));
  }, WINDOW_MS);
}

void main();
