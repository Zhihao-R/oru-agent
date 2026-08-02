/**
 * 留作长期排障工具（2026-07-13 清理审计确认保留）：唯一不启动整个应用即可验证真凭证连通性的入口。
 * Discord adapter 长连接收发——真机一次性验证（第一期 Discord 半）。
 *
 * 直接用生产 DiscordAdapter 跑真 Gateway 长连接：建连 → 收私聊 DM（经真实 normalize 打印）→
 * echo 回发，一次跑完即验证「收 + 发」整条链路，无需先启动整个 Electron app。
 *
 * 凭证安全（红线 1）：Bot Token 经 **stdin** 读入（不进 env / 不进命令行 argv / 不落日志）。
 *
 * 前置（你在 Discord Developer Portal 先配好）：
 *   ① 建 Application + Bot；② Bot → Privileged Gateway Intents 打开 **MESSAGE CONTENT INTENT**；
 *   ③ 把 bot 邀请进与你的共同服务器（或确保能私聊）；④ 用你的账号给 bot 发私聊 DM。
 *
 * 用法（交互粘贴 token，避免进 shell 历史）：
 *   npx tsx --tsconfig tsconfig.node.json scripts/discordConnCheck.ts
 *   # 运行后粘贴 Bot Token，回车，按 Ctrl-D 结束输入；随后私聊 bot 发消息
 */
import { DiscordAdapter } from '../electron/main/platform/discord/adapter';

const WINDOW_MS = 90_000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf-8').trim();
}

async function main(): Promise<void> {
  console.error('请粘贴 Bot Token，回车后按 Ctrl-D：');
  const botToken = await readStdin();
  if (!botToken) {
    console.error('未从 stdin 读到 Bot Token');
    process.exit(1);
  }

  const adapter = new DiscordAdapter({ botToken });
  let received = 0;
  console.log('正在建立 Discord Gateway 长连接…');
  const ok = await adapter.connect(async (e) => {
    received += 1;
    console.log(`\n✅ 收到 DM #${received}: text=${JSON.stringify(e.text)} chatId=${e.source.chatId} userId=${e.source.userId} cmd=${e.command ?? '-'}`);
    const r = await adapter.send(e.source.chatId, `（adapter 连通性回声）你发了：${e.text}`);
    console.log(`   ↩ 回发: ${r.ok ? '成功 messageId=' + r.messageId : '失败 ' + r.error}`);
  });
  if (!ok) {
    console.error('❌ 长连接建立失败');
    process.exit(1);
  }
  console.log(`✅ 长连接已建立。请私聊该 bot 发一条消息（${WINDOW_MS / 1000}s 窗口）…`);

  setTimeout(() => {
    console.log(`\n窗口结束，共收到 ${received} 条消息${received > 0 ? '——adapter 长连接收发跑通 ✅' : '（未收到：检查 MESSAGE CONTENT INTENT 是否打开、是否在能私聊的范围）'}`);
    void adapter.disconnect().finally(() => process.exit(0));
  }, WINDOW_MS);
}

void main();
