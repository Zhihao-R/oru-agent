/**
 * Smoke：capture→dream 链路（组七 L1）
 *
 * 按 docs/plans/2026-07-30-capture-dream-有效性测试计划.md 执行，真打 LLM。
 * capture 真实产出的 episode（比手工 fixture 碎、形态真实）+ 手工补 2 条同义碎条，
 * 然后跑 dream——验「capture 产出 dream 接得住」。
 *
 * 硬判：episode 总数不增；无 corrected-at；夜记非空（当夜日期行正下方首段非空且
 * 不是 `- ` 明细行——L1 期望发生 merge，op 明细几乎必然存在，只看小节非空会假绿）。
 * 人判：同义碎条收敛情况、合并后信息无损。
 *
 * 用法：npm run smoke:memory-chain
 * 注意：会打真实 Claude（memoryDream backend），需配好 key / OAuth。
 */
import './__smoke_isolate__'; // 必须第一行：隔离 ORU_DIR 到 tmpdir + 注册静态工具
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { runCapture } from '../../electron/main/memory/capture';
import { runDream } from '../../electron/main/memory/dream';
import {
  ensureSmokeMemoryBackend,
  episodesFromConv,
  episodeReportBlock,
  listAllEpisodes,
  makeConversation,
  makeEpisode,
  nightNoteFromChangelog,
  readChangelog,
  todayUtc,
  writeSmokeReport,
  type FixtureMessage,
} from './helpers/memoryFixtures';

const OWNER = 'local-user';

// Q1 同款三信息点对话（capture 侧真实产出比手工 fixture 碎，链路测的就是这个形态）
const L1_CONV = 'l1-three-points';
const L1_MSGS: FixtureMessage[] = [
  { role: 'user', text: '周报 dashboard 的图表配色别用渐变色，看着眼晕' },
  { role: 'assistant', text: '好，用纯色方案。' },
  { role: 'user', text: '还有，这个项目后端框架定了，用 FastAPI' },
  { role: 'assistant', text: '记下了。' },
  { role: 'user', text: '我每周三下午有固定例会，那段时间别安排别的' },
  { role: 'assistant', text: '好的，周三下午例会。' },
];

async function main(): Promise<void> {
  await ensureDefaultAgent();
  const backendInfo = await ensureSmokeMemoryBackend();
  if (!backendInfo) {
    console.error('[smoke-chain] backend 未就绪（无 Claude 登录态、也无 coding plan 凭证可注入），跑不了 LLM smoke');
    process.exit(2);
  }
  console.log(`[smoke-chain] backend ready（${backendInfo.mode} / ${backendInfo.model}），跑 capture 真实产出 episode…`);

  // 1. capture 真实产出
  await makeConversation(OWNER, L1_CONV, L1_MSGS);
  const cap = await runCapture(OWNER, L1_CONV, 0, null);
  console.log('[smoke-chain] capture outcome:', JSON.stringify(cap));
  const captured = episodesFromConv(await listAllEpisodes(OWNER), L1_CONV);
  if (captured.length === 0) {
    // capture 零产出则链路无从谈起——这次执行作废（不计红不计绿，重跑）
    console.error('[smoke-chain] capture 零落盘，链路场景无法成立，本次执行作废（请重跑）');
    process.exit(2);
  }

  // 2. 手工补 2 条与 capture 产出同义的碎 episode（措辞不同、来源不同对话）
  await makeEpisode(OWNER, {
    slug: 'l1-frag-gradient', type: 'feedback', title: '又提渐变配色眼晕',
    description: '审美偏好碎片', sources: ['l1-frag-c1'],
    content: '用户又提了一次：图表不要用渐变色，纯色看着才清爽。',
  });
  await makeEpisode(OWNER, {
    slug: 'l1-frag-fastapi', type: 'project', title: '后端框架拍板 FastAPI',
    description: '技术选型碎片', sources: ['l1-frag-c2'],
    content: '后端框架这件事定了：FastAPI，不再评估别的。',
  });

  const before = await listAllEpisodes(OWNER);
  console.log(`[smoke-chain] capture 产出 ${captured.length} 条 + 手工 2 条，共 ${before.length} 条，跑 dream…`);
  const dream = await runDream({ ownerId: OWNER, currentProjectId: null });
  console.log('[smoke-chain] dream outcome:', JSON.stringify(dream));

  const after = await listAllEpisodes(OWNER);
  const failures: string[] = [];
  if (after.length > before.length) failures.push(`L1: episode 总数增加 ${before.length} → ${after.length}（dream 不许新建）`);
  const corrected = after.filter((e) => e.correctedAt);
  for (const e of corrected)
    failures.push(
      `L1: 出现 corrected-at 标记 ${e.relPath}（chain 的 episode 是 capture 真实产出、内容不受 fixture 全控——若确有事实错误，合法纠错也会触发本条，人工核报告定性）`,
    );
  const nightNote = nightNoteFromChangelog(await readChangelog(OWNER), todayUtc());
  if (!nightNote || nightNote.startsWith('- '))
    failures.push('L1: 夜记为空或是 op 明细行（跑成功但没交代）');

  // 报告：全部 episode 现状（人判收敛与信息无损）
  const blocks: string[] = [];
  for (const e of after) blocks.push(await episodeReportBlock(OWNER, e));
  const report = [
    '# capture→dream 链路 smoke 报告（L1）',
    '',
    `- 运行时间：${new Date().toISOString()}`,
    `- backend：${backendInfo.mode} / ${backendInfo.model}（结论对应该模型，不外推其他配置）`,
    `- capture outcome：\`${JSON.stringify(cap)}\`（产出 ${captured.length} 条）`,
    `- dream outcome：\`${JSON.stringify(dream)}\``,
    `- 硬判：${failures.length === 0 ? '✅ 绿（总数不增 / 无 corrected-at / 夜记非空）' : `❌ ${failures.join('；')}`}`,
    '',
    '## 夜记全文',
    '',
    nightNote || '（空）',
    '',
    '## 人判样本：同义碎条收敛情况 + 合并后信息无损（全部 episode 现状）',
    '',
    'capture 产出条与 2 条手工碎条（l1-frag-gradient 讲渐变配色、l1-frag-fastapi 讲框架选型）是否收敛、互补要点有没有进幸存条正文。',
    '',
    ...blocks,
  ].join('\n\n');
  await writeSmokeReport('memory-chain', report);

  if (failures.length > 0) {
    console.error('[smoke-chain] ❌ 硬判失败：\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('[smoke-chain] ✅ 硬判绿。收敛质量见人判报告。');
}

main().catch((e) => {
  console.error('[smoke-chain] 异常：', e);
  process.exit(1);
});
