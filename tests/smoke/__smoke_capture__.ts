/**
 * Smoke：capture 有效性（组一纯管道硬判 + 组二模型合规 + 组三抽取质量摆样本）
 *
 * 按 docs/plans/2026-07-30-capture-dream-有效性测试计划.md 执行，真打 LLM。
 *   组一（P1/P2/P3/P6/P7）：机械硬判，红 = 代码 bug，exit 1
 *   组二（G1-G6）：合规指标，记 N/3（本脚本跑 1 次，跑 3 次由外部重复执行）
 *   组三（Q1-Q5）：人判——脚本只负责把判据需要的样本（全文 / diff）摆进报告
 *
 * 用法：npm run smoke:capture
 * 注意：会打真实 Claude（memoryDream backend），需配好 key / OAuth。
 */
import './__smoke_isolate__'; // 必须第一行：隔离 ORU_DIR 到 tmpdir + 注册静态工具
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { debugLogger } from '../../electron/main/debug/logger';
import { runCapture } from '../../electron/main/memory/capture';
import {
  capturePrompts,
  ensureSmokeMemoryBackend,
  episodesFromConv,
  episodeReportBlock,
  listAllEpisodes,
  makeConversation,
  readDebugRecords,
  readEpisodeFull,
  registerSmokeProject,
  writeSmokeReport,
  type FixtureMessage,
} from './helpers/memoryFixtures';
import type { EpisodeSummary } from '../../electron/main/memory/store';

const OWNER = 'local-user';

// ─── fixture 文案（一次写定，3 次重复共用同一份） ─────────────────

const P1_CONV = 'p1-export-csv';
const P1_MSGS: FixtureMessage[] = [
  { role: 'user', text: '我们做一下数据导出功能吧' },
  { role: 'assistant', text: '好，导出格式上有什么要求吗？' },
  { role: 'user', text: '记住了，以后导出表格一律用 CSV，别用 Excel 格式' },
  { role: 'assistant', text: '明白，导出表格一律 CSV。' },
  { role: 'user', text: '对，团队里大家都是这么用的' },
  { role: 'assistant', text: '好的，这个约定我记下了。' },
];

const P2_CONV = 'p2-incremental';
const P2_BATCH1: FixtureMessage[] = [
  { role: 'user', text: '帮我规划一下下个月的团建' },
  { role: 'assistant', text: '好，想去哪类地方？' },
  { role: 'user', text: '海边吧，大家投票都想去海边' },
  { role: 'assistant', text: '预算大概多少？' },
  { role: 'user', text: '人均八百以内' },
  { role: 'assistant', text: '那可以考虑舟山或者平潭。' },
  { role: 'user', text: '对了，楼下便利店的猫今天戴了铃铛' },
  { role: 'assistant', text: '哈哈，真可爱。' },
  { role: 'user', text: '团建时间定在第二个周末' },
  { role: 'assistant', text: '记下了，第二个周末。' },
];
const P2_BATCH2: FixtureMessage[] = [
  { role: 'user', text: '团建改到第三个周末了，第二个周末有客户来访' },
  { role: 'assistant', text: '好，改到第三个周末。' },
  { role: 'user', text: '住宿标准也提一下，改成人均一千二' },
  { role: 'assistant', text: '明白，住宿人均一千二。' },
];

// 25000 字符：每段 28 字符 × 893 段截到 25000；段号让任意切片都天然独特，切片断言不会误撞
const P3_CONV = 'p3-giant';
const P3_HUGE = Array.from(
  { length: 893 },
  (_, i) => `第${String(i).padStart(4, '0')}段：会议纪要填充正文，记录决议事项与待办安排。`,
).join('').slice(0, 25_000);

const P6_NULL_CONV = 'p6-no-project';
const P6_NULL_MSGS: FixtureMessage[] = [
  { role: 'user', text: '我在想要不要养只猫' },
  { role: 'assistant', text: '养猫是个长期决定，你在顾虑什么？' },
  { role: 'user', text: '主要是出差没人照顾，我每个月都得出差一周' },
  { role: 'assistant', text: '那确实要先解决照看问题。' },
];
const P6_PROJ_CONV = 'p6-with-project';
const P6_PROJ_MSGS: FixtureMessage[] = [
  { role: 'user', text: '这个项目的前端构建工具定了，从 webpack 迁到 Vite' },
  { role: 'assistant', text: '好，迁移排期怎么定？' },
  { role: 'user', text: '下周开始，两周内迁完' },
  { role: 'assistant', text: '明白。' },
];

const G4_CONV = 'g4-caffeine';
const G4_MSGS: FixtureMessage[] = [
  { role: 'user', text: '记住：我咖啡因过敏，别推荐咖啡' },
  { role: 'assistant', text: '好的，记下了。' },
];

const G3_CONV = 'g3-chitchat';
const G3_MSGS: FixtureMessage[] = [
  { role: 'user', text: '在吗' },
  { role: 'assistant', text: '在的，怎么啦？' },
  { role: 'user', text: '哈哈没事' },
  { role: 'assistant', text: '好。' },
  { role: 'user', text: '今天天气不错' },
  { role: 'assistant', text: '是啊，适合出门走走。' },
];

const G5_CONV = 'g5-do-not-remember';
const G5_MSGS: FixtureMessage[] = [
  { role: 'user', text: '我跟你讲个事，这个别记：我高中时被老师当众批评过，一直耿耿于怀' },
  { role: 'assistant', text: '好，这件事我不记录。' },
];

const G6_CONV = 'g6-changed-mind';
const G6_MSGS: FixtureMessage[] = [
  { role: 'user', text: '项目的存储方案讨论下来了，数据库定了 PostgreSQL' },
  { role: 'assistant', text: '好，PostgreSQL。' },
  { role: 'user', text: '不对，我说错了，刚才团队最终决定改 MySQL' },
  { role: 'assistant', text: '明白，改 MySQL。' },
];

const Q1_CONV = 'q1-three-points';
const Q1_MSGS: FixtureMessage[] = [
  { role: 'user', text: '周报 dashboard 的图表配色别用渐变色，看着眼晕' },
  { role: 'assistant', text: '好，用纯色方案。' },
  { role: 'user', text: '还有，这个项目后端框架定了，用 FastAPI' },
  { role: 'assistant', text: '记下了。' },
  { role: 'user', text: '我每周三下午有固定例会，那段时间别安排别的' },
  { role: 'assistant', text: '好的，周三下午例会。' },
];

const Q2A_CONV = 'q2-one-topic';
const Q2A_MSGS: FixtureMessage[] = [
  { role: 'user', text: '表格组件的导出格式定为 CSV' },
  { role: 'assistant', text: '好。' },
  { role: 'user', text: '这个表格组件的列排序支持点击表头升降序' },
  { role: 'assistant', text: '明白。' },
  { role: 'user', text: '还是这个表格组件，再加个冻结首行' },
  { role: 'assistant', text: '好，冻结首行。' },
];
const Q2B_CONV = 'q2-three-topics';
const Q2B_MSGS: FixtureMessage[] = [
  { role: 'user', text: '我家猫该打疫苗了，预约了周六上午' },
  { role: 'assistant', text: '好。' },
  { role: 'user', text: '周报提交时间改到周五下午了' },
  { role: 'assistant', text: '明白。' },
  { role: 'user', text: '新显示器买了台 4K 的，今天刚到' },
  { role: 'assistant', text: '不错，体验怎么样？' },
];

const Q5_CONV = 'q5-relative-time';
const Q5_MSGS: FixtureMessage[] = [
  { role: 'user', text: '下周三下午的例会改到周四了' },
  { role: 'assistant', text: '好，记下了。' },
  { role: 'user', text: '我上个月从前公司离职了，现在休息一阵' },
  { role: 'assistant', text: '辛苦了。' },
];

// ─── 报告累积 ────────────────────────────────────────────

const reportSections: string[] = [];
function report(title: string, body: string): void {
  reportSections.push(`## ${title}\n\n${body}`);
}

async function dumpEpisodes(ownerId: string, eps: EpisodeSummary[]): Promise<string> {
  if (eps.length === 0) return '（零落盘）';
  const blocks: string[] = [];
  for (const e of eps) blocks.push(await episodeReportBlock(ownerId, e));
  return blocks.join('\n\n');
}

// G2：unparseable-output 计数（console.warn hook，全矩阵累计）
let unparseableCount = 0;
const origWarn = console.warn;
console.warn = (...args: unknown[]): void => {
  if (args.some((a) => String(a).includes('unparseable-output'))) unparseableCount += 1;
  origWarn(...args);
};

// ─── 主流程 ──────────────────────────────────────────────

async function main(): Promise<void> {
  debugLogger.setEnabled(true); // P2/P3 取 prompt、G2 统计都靠 debug 日志
  await ensureDefaultAgent();
  const backendInfo = await ensureSmokeMemoryBackend();
  if (!backendInfo) {
    console.error('[smoke-capture] backend 未就绪（无 Claude 登录态、也无 coding plan 凭证可注入），跑不了 LLM smoke');
    process.exit(2);
  }
  console.log(`[smoke-capture] backend ready（${backendInfo.mode} / ${backendInfo.model}），开始跑组一（纯管道硬判）…`);

  const failures: string[] = [];

  // ── P1 落盘通路 ──
  await makeConversation(OWNER, P1_CONV, P1_MSGS);
  const p1 = await runCapture(OWNER, P1_CONV, 0, null);
  console.log('[smoke-capture] P1 outcome:', JSON.stringify(p1));
  let eps = await listAllEpisodes(OWNER);
  const p1Eps = episodesFromConv(eps, P1_CONV);
  if (p1.kind !== 'ok') failures.push(`P1: runCapture 返回 ${p1.kind}（期望 ok）`);
  if (p1.kind === 'ok' && p1Eps.length === 0) failures.push('P1: 返回 ok 但无 sources 含该 convId 的落盘条目');
  report('P1 落盘通路（硬判）', `outcome: \`${JSON.stringify(p1)}\`\n\n${await dumpEpisodes(OWNER, p1Eps)}`);

  // ── P2 游标增量不丢不重 ──
  const p2Base = Date.now() - 60_000;
  const b1Ats = await makeConversation(OWNER, P2_CONV, P2_BATCH1, p2Base);
  const p2First = await runCapture(OWNER, P2_CONV, 0, null);
  const b2Ats = await makeConversation(OWNER, P2_CONV, [...P2_BATCH1, ...P2_BATCH2], p2Base);
  const p2Second = await runCapture(OWNER, P2_CONV, p2First.coveredUntil ?? 0, null);
  console.log('[smoke-capture] P2 outcomes:', JSON.stringify({ first: p2First, second: p2Second }));
  if (p2First.coveredUntil !== b1Ats[b1Ats.length - 1])
    failures.push(`P2: 第一次 coveredUntil=${p2First.coveredUntil}，期望 ${b1Ats[b1Ats.length - 1]}`);
  if (p2Second.coveredUntil !== b2Ats[b2Ats.length - 1])
    failures.push(`P2: 第二次 coveredUntil=${p2Second.coveredUntil}，期望 ${b2Ats[b2Ats.length - 1]}`);
  // 第二次 prompt 的「本次新增的对话片段」段不得含第一批任何句子（截段落判，不受 episode 复述影响）
  await debugLogger.flushForTest();
  const p2Prompts = capturePrompts(await readDebugRecords(OWNER, `capture_${P2_CONV}`));
  const freshSection = (prompt: string): string => {
    const m = /## 本次新增的对话片段[\s\S]*?(?=\n## )/.exec(prompt);
    return m?.[0] ?? '';
  };
  if (p2Prompts.length < 2) {
    failures.push(`P2: debug 日志只读到 ${p2Prompts.length} 轮 prompt（期望 2 轮，flush 后仍缺=日志链路问题）`);
  } else {
    const second = freshSection(p2Prompts[1]);
    for (const m of P2_BATCH1) {
      if (second.includes(m.text)) failures.push(`P2: 第二次 prompt 新增段含第一批句子「${m.text.slice(0, 20)}…」`);
    }
    if (!second.includes(P2_BATCH2[0].text)) failures.push('P2: 第二次 prompt 新增段未含第二批句子（增量取错段？）');
  }
  report(
    'P2 游标增量（硬判）',
    `第一次 coveredUntil=${p2First.coveredUntil}（期望 ${b1Ats[b1Ats.length - 1]}）\n` +
      `第二次 coveredUntil=${p2Second.coveredUntil}（期望 ${b2Ats[b2Ats.length - 1]}）\n\n` +
      `第二次 prompt 的新增片段段：\n\`\`\`\n${freshSection(p2Prompts[1] ?? '')}\n\`\`\``,
  );

  // ── P3 巨型消息截断 ──
  const p3Ats = await makeConversation(OWNER, P3_CONV, [{ role: 'user', text: P3_HUGE }]);
  const p3 = await runCapture(OWNER, P3_CONV, 0, null);
  console.log('[smoke-capture] P3 outcome:', JSON.stringify(p3));
  if (p3.kind === 'failed') failures.push(`P3: 巨型消息导致 failed：${p3.error}`);
  if (p3.coveredUntil !== p3Ats[0]) failures.push(`P3: coveredUntil=${p3.coveredUntil}，期望覆盖巨型消息 ${p3Ats[0]}`);
  await debugLogger.flushForTest();
  const p3Prompt = capturePrompts(await readDebugRecords(OWNER, `capture_${P3_CONV}`))[0] ?? '';
  if (!p3Prompt.includes(P3_HUGE.slice(0, 1000))) failures.push('P3: prompt 不含巨型消息前 1000 字符');
  if (p3Prompt.includes(P3_HUGE.slice(20_001, 20_500))) failures.push('P3: prompt 含第 20001 字符之后的内容（截断失效）');
  report(
    'P3 巨型消息截断（硬判）',
    `outcome: \`${JSON.stringify(p3)}\`；消息总长 ${P3_HUGE.length} 字符\n` +
      `prompt 含前 1000 字符：${p3Prompt.includes(P3_HUGE.slice(0, 1000))}；` +
      `含 20001 后内容：${p3Prompt.includes(P3_HUGE.slice(20_001, 20_500))}`,
  );

  // ── P6 projectId 防线 ──
  const projectId = await registerSmokeProject();
  await makeConversation(OWNER, P6_NULL_CONV, P6_NULL_MSGS);
  const p6Null = await runCapture(OWNER, P6_NULL_CONV, 0, null);
  await makeConversation(OWNER, P6_PROJ_CONV, P6_PROJ_MSGS);
  const p6Proj = await runCapture(OWNER, P6_PROJ_CONV, 0, projectId);
  console.log('[smoke-capture] P6 outcomes:', JSON.stringify({ null: p6Null, proj: p6Proj }), 'projectId:', projectId);
  eps = await listAllEpisodes(OWNER);
  const p6NullEps = episodesFromConv(eps, P6_NULL_CONV);
  const p6ProjEps = episodesFromConv(eps, P6_PROJ_CONV);
  for (const e of p6NullEps) {
    if (e.scope !== 'agent') failures.push(`P6: null 侧落盘出现非 agent scope：${e.relPath} scope=${e.scope}`);
  }
  for (const e of p6ProjEps) {
    if (e.scope.startsWith('project:') && e.scope !== `project:${projectId}`)
      failures.push(`P6: 有项目侧落盘 projectId 不等于传入 id：${e.relPath} scope=${e.scope}`);
  }
  report(
    'P6 projectId 防线（硬判）',
    `注册项目 id：\`${projectId}\`\nnull 侧 outcome: \`${JSON.stringify(p6Null)}\`，落盘 ${p6NullEps.length} 条（scope 应全 agent）` +
      `${p6NullEps.length === 0 ? '（零落盘=该侧未触发，不算过也不算红）' : ''}\n` +
      `有项目侧 outcome: \`${JSON.stringify(p6Proj)}\`，落盘 ${p6ProjEps.length} 条` +
      `${p6ProjEps.length === 0 ? '（零落盘=该侧未触发，不算过也不算红）' : ''}：\n` +
      p6ProjEps.map((e) => `- ${e.relPath} scope=${e.scope}`).join('\n'),
  );

  // ── P7 user-direct 映射 / G4 用户亲口嘱记（共用数据） ──
  await makeConversation(OWNER, G4_CONV, G4_MSGS);
  const g4 = await runCapture(OWNER, G4_CONV, 0, null);
  console.log('[smoke-capture] P7/G4 outcome:', JSON.stringify(g4));
  eps = await listAllEpisodes(OWNER);
  const g4Eps = episodesFromConv(eps, G4_CONV);
  // P7 判的是映射代码（userRequested===true → user-direct）：红的前提是模型标了 true 而落盘不是
  // user-direct——模型没标 true 是 G4 的 N/3（标不标是模型的事），不报组一红。模型原文从 debug 日志读。
  await debugLogger.flushForTest();
  const g4Raw =
    (await readDebugRecords(OWNER, `capture_${G4_CONV}`))
      .filter((r) => r.type === 'llm_call_done')
      .map((r) => (r.payload as { outputText?: string }).outputText ?? '')[0] ?? '';
  const g4ModelMarked = /"userRequested"\s*:\s*true/.test(g4Raw);
  for (const e of g4Eps) {
    if (e.source !== 'user-direct' && g4ModelMarked)
      failures.push(`P7: 模型已标 userRequested=true 但落盘 source=${e.source}（applyOps 映射坏了，代码 bug）`);
  }
  const g4Marked = g4Eps.length > 0 && g4Eps.every((e) => e.source === 'user-direct');
  report(
    'P7 user-direct 映射（硬判，条件式）+ G4 用户亲口嘱记（合规 N/3）',
    `outcome: \`${JSON.stringify(g4)}\`\n模型原文标了 userRequested=true：${g4ModelMarked}\n落盘 ${g4Eps.length} 条，全部 user-direct：${g4Marked}` +
      `${g4Eps.length === 0 ? '（零落盘=P7 未触发，不算过也不算红；G4 记 0/1）' : ''}\n\n${await dumpEpisodes(OWNER, g4Eps)}`,
  );

  console.log('[smoke-capture] 组一完成，跑组二（模型合规）…');

  // ── G3 闲聊精确性 ──
  await makeConversation(OWNER, G3_CONV, G3_MSGS);
  const g3 = await runCapture(OWNER, G3_CONV, 0, null);
  eps = await listAllEpisodes(OWNER);
  const g3Eps = episodesFromConv(eps, G3_CONV);
  report(
    'G3 闲聊精确性（合规 N/3，不抓为合规）',
    `outcome: \`${JSON.stringify(g3)}\`\n落盘 ${g3Eps.length} 条（0=合规）：\n${await dumpEpisodes(OWNER, g3Eps)}`,
  );

  // ── G5 明示不记 ──
  await makeConversation(OWNER, G5_CONV, G5_MSGS);
  const g5 = await runCapture(OWNER, G5_CONV, 0, null);
  eps = await listAllEpisodes(OWNER);
  const g5Eps = episodesFromConv(eps, G5_CONV);
  report(
    'G5 明示不记（合规，零落盘为合规；红=守则缺口呈 PM）',
    `outcome: \`${JSON.stringify(g5)}\`\n落盘 ${g5Eps.length} 条（0=合规）：\n${await dumpEpisodes(OWNER, g5Eps)}`,
  );

  // ── G6 改口遵从（机械预筛 + 人判） ──
  await makeConversation(OWNER, G6_CONV, G6_MSGS);
  const g6 = await runCapture(OWNER, G6_CONV, 0, null);
  eps = await listAllEpisodes(OWNER);
  const g6Eps = episodesFromConv(eps, G6_CONV);
  const g6Dump = await dumpEpisodes(OWNER, g6Eps);
  const g6OldHits = g6Dump.includes('PostgreSQL');
  report(
    'G6 改口遵从（人判）',
    `outcome: \`${JSON.stringify(g6)}\`\n机械预筛：落盘文本含旧词「PostgreSQL」=${g6OldHits}` +
      `（命中不必然违规——叙述改口史「从 PostgreSQL 改定为 MySQL」是正确写法，需人工核语境）\n\n${g6Dump}`,
  );

  console.log('[smoke-capture] 组二完成，跑组三（抽取质量摆样本）…');

  // ── Q1 召回与分类（+ Q4 复用其产出） ──
  await makeConversation(OWNER, Q1_CONV, Q1_MSGS);
  const q1 = await runCapture(OWNER, Q1_CONV, 0, null);
  eps = await listAllEpisodes(OWNER);
  const q1Eps = episodesFromConv(eps, Q1_CONV);
  report(
    'Q1 召回与分类（人判：3 信息点各被覆盖？type/scope 贴内容？）',
    `三个信息点：图表配色别用渐变色（偏好）/ 后端框架定 FastAPI（决定）/ 每周三下午固定例会（事实）\n` +
      `outcome: \`${JSON.stringify(q1)}\`\n\n${await dumpEpisodes(OWNER, q1Eps)}`,
  );
  report(
    'Q4 正文与索引行写法（人判，复用 Q1 产出）',
    '对照守则逐条判：不写对话来回 / 不复述 title / 两三句封顶 / 自称 Oru 无 Twin 字样；' +
      'description 作为索引行是否自足（召回端只看 title+description 决定读不读全文）。样本见 Q1 节。',
  );

  // ── Q3 重启重抽判重（游标清零全量重抽） ──
  // 路径集合 diff 之外再 diff 正文：同 slug 同日覆写（relPath 不变）时「内容被重写」也要可见
  const q3BeforeTexts = new Map<string, string>();
  for (const e of await listAllEpisodes(OWNER)) {
    q3BeforeTexts.set(e.relPath, (await readEpisodeFull(OWNER, e.relPath))?.content ?? '');
  }
  const q3 = await runCapture(OWNER, Q1_CONV, 0, null);
  eps = await listAllEpisodes(OWNER);
  const q3New: EpisodeSummary[] = [];
  const q3Rewritten: string[] = [];
  for (const e of eps) {
    const text = (await readEpisodeFull(OWNER, e.relPath))?.content ?? '';
    if (!q3BeforeTexts.has(e.relPath)) q3New.push(e);
    else if (q3BeforeTexts.get(e.relPath) !== text) q3Rewritten.push(e.relPath);
  }
  report(
    'Q3 重启重抽判重（人判：零新增为优；新增需判是否上次真漏）',
    `重抽 outcome: \`${JSON.stringify(q3)}\`\n新增 ${q3New.length} 条：\n${await dumpEpisodes(OWNER, q3New)}\n\n` +
      `同路径被覆写 ${q3Rewritten.length} 条：${q3Rewritten.join('、') || '无'}（同 slug 重抽的内容抖动，判重判据的辅助信号）`,
  );

  // ── Q2 分条粒度 ──
  await makeConversation(OWNER, Q2A_CONV, Q2A_MSGS);
  const q2a = await runCapture(OWNER, Q2A_CONV, 0, null);
  await makeConversation(OWNER, Q2B_CONV, Q2B_MSGS);
  const q2b = await runCapture(OWNER, Q2B_CONV, 0, null);
  eps = await listAllEpisodes(OWNER);
  const q2aEps = episodesFromConv(eps, Q2A_CONV);
  const q2bEps = episodesFromConv(eps, Q2B_CONV);
  report(
    'Q2 分条粒度（人判：甲同批同事应≈1 条，乙三件不相干应≈3 条）',
    `甲（同一表格组件三侧面）outcome: \`${JSON.stringify(q2a)}\`，落盘 ${q2aEps.length} 条：\n${await dumpEpisodes(OWNER, q2aEps)}\n\n` +
      `乙（三件不相干的事）outcome: \`${JSON.stringify(q2b)}\`，落盘 ${q2bEps.length} 条：\n${await dumpEpisodes(OWNER, q2bEps)}`,
  );

  // ── Q5 相对时间锚定 ──
  const q5RunDate = new Date().toISOString().slice(0, 10);
  await makeConversation(OWNER, Q5_CONV, Q5_MSGS);
  const q5 = await runCapture(OWNER, Q5_CONV, 0, null);
  eps = await listAllEpisodes(OWNER);
  const q5Eps = episodesFromConv(eps, Q5_CONV);
  report(
    'Q5 相对时间锚定（人判：相对时间锚成绝对日期或保留足够上下文？）',
    `capture 运行日期：${q5RunDate}（「下周三」「上个月」以此为锚）\n` +
      `outcome: \`${JSON.stringify(q5)}\`\n\n${await dumpEpisodes(OWNER, q5Eps)}`,
  );

  // ── G1 字段合规 + G2 输出可解析（全矩阵累计） ──
  eps = await listAllEpisodes(OWNER);
  const allCaptureEps = eps;
  const TYPE_ENUM = new Set(['user', 'feedback', 'project', 'reference', 'agent']);
  const slugBad = allCaptureEps.filter((e) => {
    const name = e.relPath.split('/').pop() ?? '';
    const slug = name.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
    return !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
  });
  const typeBad = allCaptureEps.filter((e) => !TYPE_ENUM.has(e.type));
  report(
    'G1 字段合规（合规 N/3）+ G2 输出可解析（应为 0）',
    `落盘条目共 ${allCaptureEps.length} 条；slug 非法 ${slugBad.length} 条：` +
      `${slugBad.map((e) => e.relPath).join('、') || '无'}；type 非法 ${typeBad.length} 条：` +
      `${typeBad.map((e) => `${e.relPath}(${e.type})`).join('、') || '无'}\n` +
      `G2 unparseable-output 全矩阵累计：${unparseableCount} 次（0=合规）`,
  );

  // ── 汇总 + 报告落盘 ──
  const summary = [
    `# capture 有效性 smoke 报告（组一硬判 / 组二合规 / 组三人判）`,
    '',
    `- 运行时间：${new Date().toISOString()}`,
    `- backend：${backendInfo.mode} / ${backendInfo.model}（结论对应该模型，不外推其他配置）`,
    `- 组一硬判：${failures.length === 0 ? '✅ 全绿' : `❌ ${failures.length} 红（代码 bug）：${failures.join('；')}`}`,
    `- 组二/组三为单次结果——跑 3 次后按 N/3 一致性填计划结论表`,
    '',
    ...reportSections,
  ].join('\n');
  await writeSmokeReport('capture', summary);

  if (failures.length > 0) {
    console.error('[smoke-capture] ❌ 组一硬判失败（代码 bug）：\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('[smoke-capture] ✅ 组一硬判全绿。组二/组三见报告（人判 + N/3 记数）。');
}

main().catch((e) => {
  console.error('[smoke-capture] 异常：', e);
  process.exit(1);
});
