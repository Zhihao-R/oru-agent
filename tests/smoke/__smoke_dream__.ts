/**
 * Smoke：dream v2 复盘 agent 端到端（打真实 LLM）——组五保守性基线
 *
 * 按 docs/plans/2026-07-30-capture-dream-有效性测试计划.md 组五扩过：
 * 现有五场景原样保留（A 该合 / B 不该合 / C 升格 / D 不创建 / E self 保守），
 * 硬断言区从 B/D 扩到四条 + R2/R3 两条机械断言：
 *   B 不相关的不错合；D 不新建；
 *   误退防线——被 retire 的条目不得落在 {color-1, color-2, db-choice, weekend-hike}
 *   （pref-1/pref-2 是纯信号条，升格后收起是守则明文引导的合法动作，retire 与否归人判，
 *    所以不能断言「0 次 retire」，只能按条判）；
 *   无 corrected-at（fixture 里没有该纠的条目）。
 *   R2 空跑——无 episode 直接调 runDream 返回 skipped，不写任何文件含夜记
 *   （不经 runOnce，否则 .dream-state.json 会写入、目录 diff 假红）；
 *   R3 夜记落盘——changelog 当夜 `## date` 日期行正下方首段为夜记且非空、非明细行。
 * 复核统一扫活跃+archived 两层（retire/supersede 会物理移档，只扫活跃层恒假绿）。
 * 报告从「profile 前 200 字符切片」扩成全文 diff 并落盘——升格质量无从判起的问题。
 *
 * 用法：npm run smoke:dream
 * 注意：会打真实 Claude（memoryDream backend），需配好 key / OAuth。
 */
import './__smoke_isolate__'; // 必须第一行：隔离 ORU_DIR 到 tmpdir + 注册静态工具（含 dream 工具）
import { promises as fs } from 'node:fs';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { runDream } from '../../electron/main/memory/dream';
import { readAgentSelf } from '../../electron/main/memory/store';
import { changelogPath } from '../../electron/main/memory/changelog';
import {
  diffLines,
  ensureSmokeMemoryBackend,
  episodeReportBlock,
  listAllEpisodes,
  makeConversation,
  makeEpisode,
  nightNoteFromChangelog,
  readChangelog,
  readUserProfile,
  todayUtc,
  writeSmokeReport,
} from './helpers/memoryFixtures';

const OWNER = 'local-user';

/** 误退防线白名单——被 retire 的条目落在这个集合内即硬判红 */
const NO_RETIRE_SLUGS = ['color-1', 'color-2', 'db-choice', 'weekend-hike'];

async function main(): Promise<void> {
  await ensureDefaultAgent();

  const backendInfo = await ensureSmokeMemoryBackend();
  if (!backendInfo) {
    console.error('[smoke-dream] backend 未就绪（无 Claude 登录态、也无 coding plan 凭证可注入），跑不了 LLM smoke');
    process.exit(2);
  }
  console.log(`[smoke-dream] backend ready（${backendInfo.mode} / ${backendInfo.model}），先跑 R2 空跑断言（造 fixture 之前）…`);

  // ── R2 空跑：无 episode 直接调 runDream → skipped，不写任何文件含夜记 ──
  const r2 = await runDream({ ownerId: OWNER, currentProjectId: null });
  const r2ChangelogExists = await fs.access(changelogPath(OWNER)).then(() => true, () => false);
  const failures: string[] = [];
  if (r2.kind !== 'skipped') failures.push(`R2: 空跑返回 ${r2.kind}（期望 skipped）`);
  if (r2ChangelogExists) failures.push('R2: 空跑写了 changelog（应不写任何文件含夜记）');
  console.log('[smoke-dream] R2 outcome:', JSON.stringify(r2), 'changelog 存在:', r2ChangelogExists);

  console.log('[smoke-dream] 造 fixtures…');
  // A 该合：明显同一件事
  await makeEpisode(OWNER, { slug: 'color-1', type: 'user', title: '把主色改成绿色', description: '用户要求配色换绿', content: '用户说把界面主色从蓝改成绿色。', sources: ['cnv_color'] });
  await makeEpisode(OWNER, { slug: 'color-2', type: 'user', title: '绿色再调深一点', description: '用户要求绿色加深', content: '用户觉得刚才的绿太浅，要求调深一些。', sources: ['cnv_color'] });
  // B 不该合（核心）：完全不相关
  await makeEpisode(OWNER, { slug: 'db-choice', type: 'project', title: '数据库选型定 postgres', description: '技术选型', content: '讨论后后端数据库定用 PostgreSQL。', sources: ['cnv_db'] });
  await makeEpisode(OWNER, { slug: 'weekend-hike', type: 'user', title: '周末去爬山', description: '生活片段', content: '用户提到周末和朋友去爬了山。', sources: ['cnv_life'] });
  // C 升格 / E self：多条体现稳定偏好
  await makeEpisode(OWNER, { slug: 'pref-1', type: 'feedback', title: '又强调极简', description: '审美偏好', content: '用户再次表示偏好极简、克制的设计，讨厌花哨装饰。', sources: ['cnv_p1'] });
  await makeEpisode(OWNER, { slug: 'pref-2', type: 'feedback', title: '反复要去掉装饰', description: '审美偏好', content: '用户多次要求去掉多余的视觉装饰，只留必要元素。', sources: ['cnv_p2'] });

  // read_conversation 反查用：配色那条的来源对话
  await makeConversation(OWNER, 'cnv_color', [
    { role: 'user', text: '把主色改成绿色' },
    { role: 'assistant', text: '好的，已把主色换成绿色' },
    { role: 'user', text: '太浅了，再深一点' },
  ]);

  const before = await listAllEpisodes(OWNER);
  const selfBefore = await readAgentSelf(OWNER);
  const profileBefore = await readUserProfile(OWNER);
  // A 人判样本：合并前全文
  const colorBefore: string[] = [];
  for (const slug of ['color-1', 'color-2']) {
    const e = before.find((x) => x.relPath.includes(slug));
    if (e) colorBefore.push(await episodeReportBlock(OWNER, e));
  }
  console.log(`[smoke-dream] 造了 ${before.length} 条 episode，跑 runDream（打真实 LLM，可能要几十秒）…`);

  const outcome = await runDream({ ownerId: OWNER, currentProjectId: null });
  console.log('[smoke-dream] outcome:', JSON.stringify(outcome));

  const after = await listAllEpisodes(OWNER);
  const statusOf = (slug: string): string =>
    after.find((e) => e.relPath.includes(slug))?.status ?? '(消失)';
  const profileAfter = await readUserProfile(OWNER);
  const selfAfter = await readAgentSelf(OWNER);

  // ── 核心断言（硬，fail 则非 0 退出）──
  if (after.length > before.length) failures.push('D: dream 新建了 episode（应被白名单/守则禁止）');
  if (!(statusOf('db-choice') === 'active' && statusOf('weekend-hike') === 'active'))
    failures.push('B(核心): 不相关的 episode 被错误合并或误动了');
  // 误退防线：白名单集合内的条目不得被 retire（pref-1/pref-2 是合法 retire 候选，不在此列）
  for (const slug of NO_RETIRE_SLUGS) {
    const e = after.find((x) => x.relPath.includes(slug));
    if (e?.status === 'retired') failures.push(`误退防线: ${slug} 被 retire（判据「${e.retiredReason ?? ''}」）`);
  }
  // 无 corrected-at（fixture 里没有该纠的条目）
  const corrected = after.filter((e) => e.correctedAt);
  for (const e of corrected) failures.push(`无依据纠错: ${e.relPath} 被打 corrected-at=${e.correctedAt}`);
  // R3 夜记落盘：当夜日期行正下方首段非空且不是 `- ` 明细行（op 明细也进同一小节，只看小节非空会漏）
  const nightNote = nightNoteFromChangelog(await readChangelog(OWNER), todayUtc());
  if (outcome.kind === 'ok' && (!nightNote || nightNote.startsWith('- ')))
    failures.push('R3: dream 跑成功但夜记缺失或是明细行（跑成功但没交代）');

  // ── 人判报告（全文 + diff，落盘）──
  const colorAfter: string[] = [];
  for (const e of after.filter((x) => x.relPath.includes('color-'))) {
    colorAfter.push(await episodeReportBlock(OWNER, e));
  }
  const prefStatus = ['pref-1', 'pref-2']
    .map((s) => {
      const e = after.find((x) => x.relPath.includes(s));
      return `- ${s}：${e?.status ?? '(消失)'}${e?.retiredReason ? `，判据「${e.retiredReason}」` : ''}（纯信号条升格后收起是合法动作，retire 与否人判）`;
    })
    .join('\n');
  const reportMd = [
    '# dream 保守性基线 smoke 报告（组五）',
    '',
    `- 运行时间：${new Date().toISOString()}`,
    `- backend：${backendInfo.mode} / ${backendInfo.model}（结论对应该模型，不外推其他配置）`,
    `- R2 空跑：\`${JSON.stringify(r2)}\`，changelog 写入=${r2ChangelogExists}`,
    `- 主跑 outcome：\`${JSON.stringify(outcome)}\``,
    `- 硬判：${failures.length === 0 ? '✅ 全绿（B/D/误退防线/无 corrected-at/R2/R3）' : `❌ ${failures.join('；')}`}`,
    '',
    '## 夜记（R3 样本）',
    '',
    nightNote || '（空）',
    '',
    '## A 该合（人判：该合的合没合）',
    '',
    `- color-1：${statusOf('color-1')}；color-2：${statusOf('color-2')}`,
    '',
    '合并前全文：',
    '',
    ...colorBefore,
    '',
    '合并后全文：',
    '',
    ...(colorAfter.length > 0 ? colorAfter : ['（两条都不在了）']),
    '',
    '## B 不该合（硬判已过见上）',
    '',
    `- db-choice：${statusOf('db-choice')}；weekend-hike：${statusOf('weekend-hike')}`,
    '',
    '## C 升格（人判：升格质量 + 源条收起是否合法）',
    '',
    prefStatus,
    '',
    'profile 全文 diff：',
    '',
    '```diff',
    diffLines(profileBefore, profileAfter),
    '```',
    '',
    '## E self 保守（人判：信号不确凿不乱改）',
    '',
    `self 是否变化：${selfBefore !== selfAfter}`,
    '',
    'self 全文 diff：',
    '',
    '```diff',
    diffLines(selfBefore, selfAfter),
    '```',
  ].join('\n');
  await writeSmokeReport('dream-baseline', reportMd);
  console.log('[smoke-dream] 摘要：', JSON.stringify({
    A: { 'color-1': statusOf('color-1'), 'color-2': statusOf('color-2') },
    B: { 'db-choice': statusOf('db-choice'), 'weekend-hike': statusOf('weekend-hike') },
    D: { 复盘前: before.length, 复盘后: after.length },
    E: { self变化: selfBefore !== selfAfter },
  }));

  if (failures.length > 0) {
    console.error('[smoke-dream] ❌ 核心断言失败：\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('[smoke-dream] ✅ 核心断言通过（B 不乱合 / D 不创建 / 误退防线 / 无 corrected-at / R2 / R3）。A/C/E 见报告人工判断质量。');
}

main().catch((e) => {
  console.error('[smoke-dream] 异常：', e);
  process.exit(1);
});
