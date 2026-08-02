/**
 * 召回评估语料（PRD §7.1）—— 四桶 golden + 措辞故意错开 + 可配填充到 N≈1000
 *
 * 每条 golden 记忆体里埋一个唯一 token；查询用**和记忆里不同的说法**问（测「换个说法也找得到」）。
 * 填充项是与 golden 无关的噪声，制造规模压力（活跃集大时召回是否仍准）。
 */
import type { EpisodeFixture } from '../retrieval/corpus';
import type { BucketQuery, RecallCorpus } from './recallEval';

/** 跨项目桶所属项目 id（G20：非该项目回合应把它排除出候选）。 */
export const CROSS_PROJECT_ID = 'prj_alpha';

/** 四桶 golden episode（含唯一 token） + 对应「换说法」查询 */
const GOLDEN: { ep?: EpisodeFixture; query: BucketQuery }[] = [
  {
    // 近期：记的是「换房计划」，问的是「搬家」
    ep: {
      scope: 'agent', type: 'user', slug: 'huanfang', date: '2026-06-20',
      title: '换房计划', description: '想换个小户型', body: '用户在考虑换房，倾向小户型、近地铁。TOKEN_RECENT', tags: [],
    },
    query: { q: '我们之前聊的搬家那事还记得吗', token: 'TOKEN_RECENT', bucket: 'recent' },
  },
  {
    // 久远：记的是「戒糖」，问的是「少吃甜的」
    ep: {
      scope: 'agent', type: 'user', slug: 'jietang', date: '2025-02-10',
      title: '戒糖', description: '开始控制糖分', body: '用户去年开始戒糖、控制甜食摄入。TOKEN_DISTANT', tags: [],
    },
    query: { q: '我之前是不是说过要少吃甜的', token: 'TOKEN_DISTANT', bucket: 'distant' },
  },
  {
    // 跨项目：项目里记的「发布节奏」，问的是「多久上线一次」
    ep: {
      scope: 'project', projectId: CROSS_PROJECT_ID, type: 'project', slug: 'fabu', date: '2026-04-01',
      title: '发布节奏', description: '两周一个版本', body: 'alpha 项目约定两周发一个版本。TOKEN_CROSS', tags: [],
    },
    query: { q: 'alpha 那个项目大概多久上线一次来着', token: 'TOKEN_CROSS', bucket: 'cross-project' },
  },
  {
    // 必记：用户明确要记的过敏信息 → 进常驻档案（不靠召回挑选）
    query: { q: '帮我点份午饭，注意我的饮食禁忌', token: 'TOKEN_MUST', bucket: 'must-remember' },
  },
];

/** 必记桶写进 user/profile.md 常驻档案的正文（埋 TOKEN_MUST） */
const PROFILE_BODY = '对你的整体印象。\n\n## 饮食禁忌\n对花生严重过敏，绝不能碰。TOKEN_MUST';

function makeFillers(count: number): EpisodeFixture[] {
  const out: EpisodeFixture[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      scope: 'agent', type: 'user', slug: `filler-${i}`,
      date: `2026-05-${String((i % 28) + 1).padStart(2, '0')}`,
      title: `杂事 ${i}`, description: `无关噪声 ${i}`, body: `一些与 golden 无关的日常记录 ${i}`, tags: [],
    });
  }
  return out;
}

/** N≈1000 时传 fillers≈1000；CI 自检传少量即可 */
export function buildRecallCorpus(opts?: { fillers?: number }): RecallCorpus {
  const episodes = [
    ...GOLDEN.map((g) => g.ep).filter((e): e is EpisodeFixture => !!e),
    ...makeFillers(opts?.fillers ?? 12),
  ];
  return {
    episodes,
    profileBody: PROFILE_BODY,
    queries: GOLDEN.map((g) => g.query),
    crossProjectId: CROSS_PROJECT_ID,
  };
}
