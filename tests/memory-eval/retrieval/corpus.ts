/**
 * 检索侧评估语料 + 金标准（决策 1 / Task 1）
 *
 * 这份语料是整个召回评估的地基——它的可靠性决定评估可不可信。两条铁律：
 *
 * 1. **措辞故意错位**：≥半数 query 的用词与对应 episode 的字面**不重叠**（同义 / 上位 /
 *    口语 vs 书面）。这是暴露 grep 子串 miss 的关键。合成数据最容易自欺的地方就是
 *    "query 用词无意中命中记忆、让 grep 假装很准"——所以这里显式对抗：每条 paraphrase
 *    query 都刻意避开 episode 正文里的内容词，并由 `corpus invariants` 单测用 bigram
 *    重叠机械校验（见 retrieval.test.ts）。
 *
 * 2. **规模压过截断线**：episode ≥500（注入索引视图 200 行截断线的安全垫），确保截断
 *    **必然发生**，能压测"漏召回"。truncation-mode 的 golden 刻意给老日期、塞在拥挤
 *    type 里，被 computeIndexQuotas 挤出注入视图。
 *
 * 语料分两部分：
 *   - TOPICS：手工撰写的"有意义"episode（带 golden query），跨 5 type、措辞经过设计。
 *   - 填充 episode：程序生成的干扰项，词汇域与 TOPICS/query 刻意不相交（防 grep 误命中），
 *     把总数推过 500、制造截断压力。
 */
import type { EpisodeType } from '@shared/types';

export type EpisodeFixture = {
  scope: 'agent' | 'project';
  projectId?: string; // scope=project 时必填
  type: EpisodeType;
  slug: string;
  date: string; // YYYY-MM-DD（用作文件名前缀 + frontmatter updated）
  title: string;
  description: string;
  body: string;
  tags: string[];
};

/** query 的失效模式标注——只用于报告分桶，不影响打分 */
export type QueryMode =
  | 'lexical' // 用词与 episode 重叠（对照组：grep 应能命中）
  | 'paraphrase' // 同义 / 上位 / 口语，字面不重叠（测 grep 子串 miss）
  | 'truncation'; // golden 是被注入索引挤出的老 episode（测截断漏召回）

export type Query = {
  q: string;
  golden: string[]; // 应召回的 episode compressedPath（twin/<date>-<slug> 或 <projectId>/<date>-<slug>）
  mode: QueryMode;
};

export type Corpus = {
  episodes: EpisodeFixture[];
  queries: Query[];
};

// ─── compressedPath 计算（与 compressedPath.ts 同构，避免测试依赖运行时实现） ──────

export function goldenOf(ep: EpisodeFixture): string {
  const scopeName = ep.scope === 'project' ? (ep.projectId ?? '') : 'twin';
  return `${scopeName}/${ep.date}-${ep.slug}`;
}

// ─── TOPICS：手工撰写的有意义 episode ──────────────────────────
//
// 每条都配一个 query（见下）。撰写时刻意让 paraphrase query 的内容词避开本 episode 正文，
// 让 lexical query 保留重叠（对照）。日期跨度 2025-12 ~ 2026-05，全部 >3 天，会带 [N 天未更新]。

type Topic = {
  ep: EpisodeFixture;
  query: { q: string; mode: QueryMode };
};

const TOPICS: Topic[] = [
  // ── user 类（用户的事件 / 偏好） ──
  {
    ep: {
      scope: 'agent', type: 'user', slug: 'short-video-workflow', date: '2026-01-12',
      title: '短视频制作流程梳理', description: '用户整理了一套短视频的成片节奏与脚本结构',
      body: '用户把短视频的脚本结构拆成三段：钩子、正文、收束。强调成片前先写逐字稿，再按节奏切镜头。',
      tags: ['内容创作', '视频'],
    },
    // paraphrase：用 "剪 vlog / 自媒体" 这类口语，避开 "短视频/脚本/节奏/镜头"
    query: { q: '我之前是怎么弄那个自媒体片子的来着', mode: 'paraphrase' },
  },
  {
    ep: {
      scope: 'agent', type: 'user', slug: 'morning-routine', date: '2026-02-03',
      title: '雷打不动早起习惯', description: '用户每天清晨固定起身，持续多年',
      body: '用户保持每天清晨固定时间起身的作息，已坚持五年，周末也不打破。',
      tags: ['作息', '习惯'],
    },
    query: { q: '我几点起床这事你还记得吗', mode: 'paraphrase' }, // 避开"早起/清晨/作息/每天"
  },
  {
    ep: {
      scope: 'agent', type: 'user', slug: 'editor-preference-vscode', date: '2026-05-30',
      title: '开发用 VS Code', description: '用户选 VS Code，看重扩展生态',
      body: '用户开发主力编辑器是 VS Code，不用 Cursor 也不用 JetBrains，理由是扩展生态最全。',
      tags: ['工具', '偏好'],
    },
    query: { q: '我平时敲代码用哪个编辑器', mode: 'lexical' }, // "编辑器"重叠（对照）
  },
  {
    ep: {
      scope: 'agent', type: 'user', slug: 'english-study-habit', date: '2025-12-28',
      title: '每日英语学习', description: '用户每天投入固定时长练英语',
      body: '用户每天花半小时学英语，主要是听播客和读 The Economist，已坚持两年。',
      tags: ['学习', '习惯'],
    },
    query: { q: '我学外语这件事记一下', mode: 'paraphrase' }, // "外语" vs "英语"，避开"坚持"
  },
  {
    ep: {
      scope: 'agent', type: 'user', slug: 'cooking-fast', date: '2026-02-18',
      title: '做饭追求快', description: '用户下厨讲究效率，不愿耗时',
      body: '用户做饭的核心诉求是快——工作日晚上要在二十分钟内出锅，备菜也尽量提前。',
      tags: ['生活', '偏好'],
    },
    query: { q: '我在厨房里最在意的是什么', mode: 'paraphrase' }, // 避开"做饭/快/出锅"
  },

  // ── feedback 类（用户对 Twin 的反馈） ──
  {
    ep: {
      scope: 'agent', type: 'feedback', slug: 'role-is-pm-not-engineer', date: '2026-01-15',
      title: '你的定位是 PM 不是工程师', description: '用户要 Twin 拆问题，不要替写代码',
      body: '用户明确 Twin 的角色是产品经理：帮他把问题拆清楚就行，不要替他写代码。',
      tags: ['角色', '协作'],
    },
    query: { q: '你该把自己当成我的什么人', mode: 'paraphrase' }, // 避开"角色/定位/PM/工程师/代码"
  },
  {
    ep: {
      scope: 'agent', type: 'feedback', slug: 'specs-need-ux-chapter', date: '2026-03-02',
      title: '方案文档要突出体验章节', description: '用户要 spec 把用户体验当核心，技术细节克制',
      body: '用户反馈：写方案文档时"用户体验"那一章是核心，技术细节要控制颗粒度、别铺开。',
      tags: ['文档', '反馈'],
    },
    query: { q: '我对你写设计稿有什么要求', mode: 'paraphrase' }, // "设计稿" vs "方案文档/spec"
  },
  {
    ep: {
      scope: 'agent', type: 'feedback', slug: 'no-jargon-shorthand', date: '2026-02-25',
      title: '别在文档里带对话速记', description: '用户要求 spec 不能出现 A/B/方向1 这类速记',
      body: '用户提醒：spec 里不要留对话速记（像"方案 A/B""方向 1/2"），脱离上下文也得能读懂。',
      tags: ['文档', '反馈'],
    },
    query: { q: '写东西的时候哪些缩写不能用', mode: 'paraphrase' }, // "缩写" vs "速记"，字面不重叠
  },
  {
    ep: {
      scope: 'agent', type: 'feedback', slug: 'consult-before-ux-decision', date: '2026-05-30',
      title: '体验决策先商量再做', description: '用户要 Twin 在动用户可感知方案前先对齐',
      body: '用户要求：凡是用户能感知到的方案，先跟他对齐再动手；纯内部实现自己决定即可。',
      tags: ['协作', '决策'],
    },
    query: { q: '什么样的事情你要先问过我', mode: 'paraphrase' }, // 避开"体验/决策/对齐/方案"
  },

  // ── project 类（项目内事件） ──
  {
    ep: {
      scope: 'project', projectId: 'oru', type: 'project', slug: 'backend-multi-provider', date: '2026-01-08',
      title: 'agent backend 要 provider 无关', description: 'Oru 的 driver 必须跨多家模型供应商',
      body: 'Oru 的 agent driver 设计成 provider 无关：记忆、工具、注入都通过统一 backend 接口走，换供应商零成本。',
      tags: ['架构', 'backend'],
    },
    query: { q: 'Oru 换另一家厂商时为什么不用改代码', mode: 'paraphrase' }, // 避开"provider/backend/driver/接口/模型/供应商"
  },
  {
    ep: {
      scope: 'project', projectId: 'oru', type: 'project', slug: 'large-html-decks', date: '2026-02-09',
      title: 'deck 会产出超大 HTML', description: 'Oru 的 deck 生成大文件，工具链别假设小文件',
      body: 'Oru 的 deck 功能会生成很大的 HTML 文件，文件工具链、diff、守卫都不能假设输入是小文件。',
      tags: ['deck', '约束'],
    },
    query: { q: 'Oru 哪一块做出来的网页特别占地方', mode: 'paraphrase' }, // 避开"功能/产出/HTML/大文件"
  },
  {
    ep: {
      scope: 'project', projectId: 'oru', type: 'project', slug: 'v05-cut-deadline', date: '2026-01-30',
      title: '月底前 cut v0.5', description: 'Oru 计划月底切出 v0.5 给早期用户',
      body: 'Oru 计划在月底前 cut 出 v0.5，交给几位早期用户做 dogfooding，其中两位是前同事。',
      tags: ['里程碑', '计划'],
    },
    query: { q: 'Oru 那个第一个版本打算啥时候交出去', mode: 'paraphrase' }, // 避开"v0.5/cut/月底/早期"
  },
  {
    ep: {
      scope: 'project', projectId: 'oru', type: 'project', slug: 'memory-is-foundation', date: '2026-05-30',
      title: '记忆是所有能力的地基', description: 'Oru 把记忆系统定位为分身能力的根基',
      body: 'Oru 的判断：记忆系统是所有分身能力的地基，先把它做扎实再谈上层功能。',
      tags: ['记忆', '定位'],
    },
    query: { q: '在 Oru 里哪个模块是垫在最下面的那层', mode: 'paraphrase' }, // 避开"系统/地基/能力/根基"
  },
  {
    ep: {
      scope: 'project', projectId: 'taskboard', type: 'project', slug: 'comment-thread-model', date: '2026-02-14',
      title: 'taskboard 评论用线程模型', description: 'taskboard 的评论按线程组织',
      body: 'taskboard 的任务评论采用线程模型，每条任务下挂一棵评论树，支持嵌套回复。',
      tags: ['taskboard', '数据模型'],
    },
    query: { q: 'taskboard 里大家的留言最后是怎么串到一起的', mode: 'paraphrase' }, // "留言" vs "评论"，避开"线程/树/组织"
  },

  // ── reference 类（外部资源参考） ──
  {
    ep: {
      scope: 'agent', type: 'reference', slug: 'prompt-cache-ttl', date: '2026-01-05',
      title: 'Anthropic prompt 缓存 5 分钟 TTL', description: '记录缓存有效期，用于排期睡眠间隔',
      body: '参考：Anthropic 的 prompt 缓存有效期是五分钟，超过就 miss。后续设计轮询间隔时要避开这条线。',
      tags: ['参考', '缓存'],
    },
    query: { q: '那个临时存下来的东西大概能保留多久', mode: 'paraphrase' }, // 避开"缓存/prompt/TTL/五分钟"
  },
  {
    ep: {
      scope: 'agent', type: 'reference', slug: 'economist-subscription', date: '2026-05-30',
      title: 'The Economist 订阅', description: '用户的英文读物来源',
      body: '参考：用户长期订阅 The Economist 作为英文阅读材料，每周精读两到三篇。',
      tags: ['参考', '阅读'],
    },
    query: { q: '我固定看的那本英文刊物叫什么', mode: 'lexical' }, // "英文"重叠（对照）
  },
  {
    ep: {
      scope: 'agent', type: 'reference', slug: 'local-embedding-option', date: '2026-03-20',
      title: '本地嵌入模型选型备忘', description: '若上语义检索，倾向本地嵌入契合隐私',
      body: '参考：若未来上语义检索，倾向本地嵌入模型 + 几百条向量内存余弦，契合本地优先的隐私取向，不引入向量库。',
      tags: ['参考', '检索'],
    },
    query: { q: '万一以后要按意思找记忆打算用什么技术路线', mode: 'paraphrase' }, // 避开"语义检索/嵌入/向量"
  },

  // ── agent 类（Twin 自己的状态变化） ──
  {
    ep: {
      scope: 'agent', type: 'agent', slug: 'tone-restrained', date: '2026-01-18',
      title: 'Twin 表达趋向克制', description: 'Twin 调整为更克制的语气',
      body: 'Twin 把表达风格调整得更克制：少铺垫、直接给结论，不过度确认。',
      tags: ['persona', '风格'],
    },
    query: { q: '你说话的腔调后来有什么变化', mode: 'paraphrase' }, // "腔调" vs "表达/语气/克制"
  },
  {
    ep: {
      scope: 'agent', type: 'agent', slug: 'auto-review-habit', date: '2026-05-30',
      title: '完成后自动派 reviewer', description: 'Twin 养成完成即并行 review 的习惯',
      body: 'Twin 形成习惯：任何代码或方案做完，主动并行派多个独立 reviewer，去重分级后再汇报。',
      tags: ['persona', '流程'],
    },
    query: { q: '活干完之后你一般会自觉做哪一步', mode: 'paraphrase' }, // 避开"review/reviewer/派"
  },

  // ── truncation 专项：老日期、塞在拥挤 type，应被注入索引挤出 ──
  {
    ep: {
      scope: 'agent', type: 'user', slug: 'old-allergy-note', date: '2025-12-01',
      title: '对花生过敏', description: '用户的一条饮食禁忌',
      body: '用户对花生过敏，外食时会主动避开含花生的菜品。',
      tags: ['健康', '饮食'],
    },
    // 这条是老 user 记忆，user 类会被大量近期填充挤满 → 注入挤出；query 用 lexical 让 grep 有机会兜回
    query: { q: '我对花生这种东西是不是过敏', mode: 'truncation' },
  },
  {
    ep: {
      scope: 'project', projectId: 'oru', type: 'project', slug: 'old-naming-convention', date: '2025-12-05',
      title: '早期命名约定：纯函数提到顶层', description: 'Oru 早期定的一条代码约定',
      body: 'Oru 早期约定：可纯函数化的逻辑提到模块顶层独立导出，方便单测，不埋在闭包里。',
      tags: ['约定', '代码'],
    },
    query: { q: 'Oru 一开始定的那条关于把逻辑拆出来测的规矩是啥', mode: 'truncation' },
  },
  // feedback truncation：老反馈被近期 feedback 填充挤出注入；query 措辞错开（避开"结论/展开/铺垫/回答"）
  {
    ep: {
      scope: 'agent', type: 'feedback', slug: 'old-reply-brevity', date: '2025-12-08',
      title: '回答先抛结论再展开', description: '用户早期要 Twin 先给结论',
      body: '用户早期反馈：希望回答先抛结论、再按需展开，不要长篇铺垫。',
      tags: ['反馈', '风格'],
    },
    query: { q: '你早先是不是被叮嘱过别绕圈子', mode: 'truncation' }, // 避开"结论/展开/铺垫/回答/长篇"
  },
  // reference truncation：老参考被近期 reference 填充挤出；query 避开"原则/决策/清单/读"
  {
    ep: {
      scope: 'agent', type: 'reference', slug: 'old-book-principles', date: '2025-12-12',
      title: '在读《原则》', description: '用户提过的一本书',
      body: '参考：用户在读 Ray Dalio 的《原则》，认同其中把决策做成清单的思路。',
      tags: ['参考', '阅读'],
    },
    query: { q: '我提过在翻的那本讲怎么拿主意的外国人写的', mode: 'truncation' }, // 避开"原则/决策/清单/读/书"
  },
  // agent truncation：Twin 老状态被近期 agent 填充挤出；query 避开"道歉/致歉/分歧/判断"
  {
    ep: {
      scope: 'agent', type: 'agent', slug: 'old-over-apology', date: '2025-12-18',
      title: 'Twin 早期爱道歉', description: 'Twin 早期过度致歉，后改掉',
      body: 'Twin 早期遇到分歧爱反复道歉，后调整为直接给判断、不无谓致歉。',
      tags: ['persona', '风格'],
    },
    query: { q: '你以前是不是动不动就跟我赔不是', mode: 'truncation' }, // 避开"道歉/致歉/分歧/判断"
  },
];

// ─── 程序生成填充 episode：词汇域与上面刻意不相交 ─────────────────
//
// 填充项只为制造截断压力 + 噪声，不参与 golden。用一组与 TOPICS/query 无关的词汇
// （天气、版本号、杂务），避免 grep 误命中 golden query 的关键词。

const FILLER_NOUNS = [
  '气象记录', '版本号微调', '依赖升级', '磁盘清理', '证书续期', '时区校准',
  '日志轮转', '端口占用', '字体替换', '快照备份', '缓存预热', '心跳探测',
];
const FILLER_VERBS = ['登记', '核对', '巡检', '归档', '校验', '复核'];

/** 生成 N 条某 type 的填充 episode，日期集中在近期（挤占注入配额） */
function makeFillers(type: EpisodeType, count: number, startIdx: number): EpisodeFixture[] {
  const out: EpisodeFixture[] = [];
  for (let i = 0; i < count; i += 1) {
    const n = startIdx + i;
    const noun = FILLER_NOUNS[n % FILLER_NOUNS.length];
    const verb = FILLER_VERBS[n % FILLER_VERBS.length];
    // 近期日期：2026-04 ~ 2026-05，按序号铺开（比 TOPICS 的老日期新 → 挤占配额）
    const day = (n % 28) + 1;
    const month = 4 + (Math.floor(n / 28) % 2); // 4 或 5
    const date = `2026-0${month}-${String(day).padStart(2, '0')}`;
    const isProject = type === 'project';
    out.push({
      scope: isProject ? 'project' : 'agent',
      projectId: isProject ? 'filler' : undefined,
      type,
      slug: `filler-${type}-${n}`,
      date,
      title: `${noun}${verb} #${n}`,
      description: `例行${noun}的一次${verb}（编号 ${n}）`,
      body: `这是一条用于压测截断的填充记忆：对${noun}做了第 ${n} 次${verb}，无业务含义。`,
      tags: ['filler', noun],
    });
  }
  return out;
}

// 每 type 约 100 条填充，总计 ~500+（含 TOPICS）。日期新于 TOPICS → 把 truncation-target 挤出。
const FILLERS: EpisodeFixture[] = [
  ...makeFillers('user', 110, 0),
  ...makeFillers('feedback', 100, 200),
  ...makeFillers('project', 100, 400),
  ...makeFillers('reference', 90, 600),
  ...makeFillers('agent', 90, 800),
];

// ─── 导出 ──────────────────────────────────────────────────

export const episodes: EpisodeFixture[] = [...TOPICS.map((t) => t.ep), ...FILLERS];

/** 按 slug 取 golden——给 EXTRA_QUERIES 引用既有 episode，typo 由 corpus 不变量测兜住 */
function bySlug(slug: string): string {
  const ep = episodes.find((e) => e.slug === slug);
  if (!ep) throw new Error(`corpus: no episode with slug ${slug}`);
  return goldenOf(ep);
}

/**
 * 补充 query：同一条 episode 既有 paraphrase（测 grep 子串 miss）又有 lexical（测 grep-hit 对照），
 * 把 type × 失效模式矩阵填得更满。lexical 必须与 episode 共享内容词（由对照组单测守住）。
 */
const EXTRA_QUERIES: Query[] = [
  { q: '我那套短视频的脚本结构是怎么拆的', golden: [bySlug('short-video-workflow')], mode: 'lexical' },
  { q: '我做饭是不是特别讲究快', golden: [bySlug('cooking-fast')], mode: 'lexical' },
  { q: '你是不是不应该替我写代码', golden: [bySlug('role-is-pm-not-engineer')], mode: 'lexical' },
  { q: '用户能感知的方案是不是要先跟我对齐', golden: [bySlug('consult-before-ux-decision')], mode: 'lexical' },
  { q: 'Oru 的统一接口为什么要做到 provider 无关', golden: [bySlug('backend-multi-provider')], mode: 'lexical' },
  { q: '你的表达风格是不是后来更克制了', golden: [bySlug('tone-restrained')], mode: 'lexical' },
  { q: '你做完方案会不会自己并行去审一遍', golden: [bySlug('auto-review-habit')], mode: 'lexical' },

  // ── 扩充 1：paraphrase（措辞错开，零内容词重叠，测 grep 子串 miss）──
  { q: '我写代码用的那套软件是哪个牌子的', golden: [bySlug('editor-preference-vscode')], mode: 'paraphrase' }, // 避开"编辑器/开发/扩展/生态"
  { q: '我常翻的那份海外刊物叫啥', golden: [bySlug('economist-subscription')], mode: 'paraphrase' }, // 避开"英文/订阅/阅读/精读"
  { q: '我弄吃的最看重哪一点', golden: [bySlug('cooking-fast')], mode: 'paraphrase' }, // 避开"做饭/快/出锅/备菜"
  { q: '我平时练那门外语下多少功夫', golden: [bySlug('english-study-habit')], mode: 'paraphrase' }, // "外语"vs"英语"，避开"每天/半小时/播客"

  // ── 扩充 2：lexical（对照组，与 episode 共享内容词，grep 应命中）──
  { q: '我每天学英语大概花多久', golden: [bySlug('english-study-habit')], mode: 'lexical' },
  { q: '写方案文档时用户体验那一章要当核心', golden: [bySlug('specs-need-ux-chapter')], mode: 'lexical' },
  { q: 'Oru 的 deck 会生成很大的 HTML 文件吗', golden: [bySlug('large-html-decks')], mode: 'lexical' },
  { q: '记忆系统是不是所有分身能力的地基', golden: [bySlug('memory-is-foundation')], mode: 'lexical' },
  { q: 'Anthropic 的 prompt 缓存有效期是五分钟吧', golden: [bySlug('prompt-cache-ttl')], mode: 'lexical' },
  { q: '你早期是不是爱反复道歉', golden: [bySlug('old-over-apology')], mode: 'lexical' }, // 给 agent-truncation 配对照：grep 能否兜回被截断的老记忆
];

export const queries: Query[] = [
  ...TOPICS.map((t) => ({
    q: t.query.q,
    golden: [goldenOf(t.ep)],
    mode: t.query.mode,
  })),
  ...EXTRA_QUERIES,
];

export const corpus: Corpus = { episodes, queries };

// 给测试 / 报告用的便捷统计
export const TOPIC_COUNT = TOPICS.length;
