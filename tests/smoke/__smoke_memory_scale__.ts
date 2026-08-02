/**
 * Smoke：dream 规模去重与冲突处理（组四 D1/D2 + 组六 X1-X3）
 *
 * 按 docs/plans/2026-07-30-capture-dream-有效性测试计划.md 执行，真打 LLM。
 *   D1 规模去重：25 条 episode（5 同义簇×3 + 8 独立事件条 + 2 违规条），seed 固定交错散布
 *   D2 幂等：D1 跑完原样再跑一次，第二次 0 次写操作为绿
 *   X1 旧认知被新证据推翻 / X2 错误已升格进档案 / X3 超预算档案重写
 *
 * 硬判语义（计划）：红 = 底线失守（可能出在模型也可能出在守则条款缺口），
 * 不按代码 bug 上报，定性写在报告里呈 PM。组一的「红=代码 bug」不在本文件。
 *
 * 用法：npm run smoke:memory-scale        （seed=1）
 *      SMOKE_SEED=2 npm run smoke:memory-scale
 * 注意：会打真实 Claude（memoryDream backend），需配好 key / OAuth。
 */
import './__smoke_isolate__'; // 必须第一行：隔离 ORU_DIR 到 tmpdir + 注册静态工具
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { debugLogger } from '../../electron/main/debug/logger';
import { runDream } from '../../electron/main/memory/dream';
import {
  countToolCalls,
  diffLines,
  ensureSmokeMemoryBackend,
  episodeReportBlock,
  listAllEpisodes,
  makeConversation,
  makeEpisode,
  mulberry32,
  readEpisodeFull,
  readLatestDebugRecords,
  readUserProfile,
  resetMemory,
  shuffled,
  toolCallDetails,
  writeSmokeReport,
  writeUserProfile,
  type FixtureEpisode,
} from './helpers/memoryFixtures';
import type { EpisodeSummary } from '../../electron/main/memory/store';

const OWNER = 'local-user';
// 3 次重复各一个 seed（计划：seed 固定可复现），由外部环境变量指定
const SEED = Number(process.env.SMOKE_SEED ?? '1');
// dream 的写工具名单——D1 报告明细与 D2 幂等计数共用一份
const DREAM_WRITE_TOOLS = ['merge_episodes', 'retire_episode', 'correct_episode', 'write_memory', 'edit_memory'];

// ─── D1 fixture（25 条，一次写定，3 次重复共用） ─────────────────

type Cluster = { id: string; label: string; members: FixtureEpisode[] };

const D1_CLUSTERS: Cluster[] = [
  {
    id: 'resume',
    label: '簇1·共同 sources 一次协作切出的侧面条（简历改写三侧面）',
    members: [
      {
        slug: 'd1-resume-structure', type: 'project', title: '简历改写：结构侧面',
        description: '项目经验前置', sources: ['d1-c-resume'],
        content: '简历改写时定了结构方向：项目经验前置到教育背景之前，最近一份工作的项目展开写。',
      },
      {
        slug: 'd1-resume-quantify', type: 'project', title: '简历改写：措辞侧面',
        description: '成果量化', sources: ['d1-c-resume'],
        content: '简历措辞上定了量化原则：每条职责配一个可衡量的数字，把「负责」改成「做到」。',
      },
      {
        slug: 'd1-resume-layout', type: 'project', title: '简历改写：版式侧面',
        description: '单栏一页', sources: ['d1-c-resume'],
        content: '简历版式定了单栏、控制在一页以内，去掉装饰性图标。',
      },
    ],
  },
  {
    id: 'cilantro',
    label: '簇2·跨对话同义重复（不吃香菜，三种措辞）',
    members: [
      {
        slug: 'd1-no-cilantro-a', type: 'user', title: '不吃香菜',
        description: '饮食禁忌', sources: ['d1-c-food-a'],
        content: '用户明确说不吃香菜，点餐时会主动要求不要放。',
      },
      {
        slug: 'd1-no-cilantro-b', type: 'user', title: '香菜是雷区',
        description: '外卖备注免香菜', sources: ['d1-c-food-b'],
        content: '香菜是用户的饮食雷区：外卖备注永远写免香菜，闻到味道就反感。',
      },
      {
        slug: 'd1-no-cilantro-c', type: 'user', title: '饮食禁忌之首',
        description: '首要禁忌是香菜', sources: ['d1-c-food-c'],
        content: '用户的饮食禁忌里排第一的是香菜，聚餐点菜要先确认没有。',
      },
    ],
  },
  {
    id: 'verbatim',
    label: '簇3·字面重复（极简设计偏好，三条同文）',
    members: [
      {
        slug: 'd1-minimal-a', type: 'feedback', title: '偏好极简设计',
        description: '去装饰', sources: ['d1-c-design-a'],
        content: '用户偏好极简设计风格，反复要求去掉多余装饰，只留必要元素。',
      },
      {
        slug: 'd1-minimal-b', type: 'feedback', title: '偏好极简设计',
        description: '去装饰', sources: ['d1-c-design-b'],
        content: '用户偏好极简设计风格，反复要求去掉多余装饰，只留必要元素。',
      },
      {
        slug: 'd1-minimal-c', type: 'feedback', title: '偏好极简设计',
        description: '去装饰', sources: ['d1-c-design-c'],
        content: '用户偏好极简设计风格，反复要求去掉多余装饰，只留必要元素。',
      },
    ],
  },
  {
    id: 'progress',
    label: '簇4·已被超越的进度态（记忆系统改造三步，前两步已结束）',
    members: [
      {
        slug: 'd1-proj-step1', type: 'project', title: '记忆系统改造进入方案设计',
        description: '项目进度', sources: ['d1-c-proj-a'],
        content: '记忆系统改造项目本周进入方案设计阶段，在对比两版存储方案。',
      },
      {
        slug: 'd1-proj-step2', type: 'project', title: '记忆系统改造进入实施',
        description: '项目进度', sources: ['d1-c-proj-b'],
        content: '记忆系统改造方案设计已定稿，进入实施阶段，先从索引层改起。',
      },
      {
        slug: 'd1-proj-step3', type: 'project', title: '记忆系统改造已完成上线',
        description: '项目进度', sources: ['d1-c-proj-c'],
        content: '记忆系统改造已完成并上线，进入一周观察期，暂未见异常反馈。',
      },
    ],
  },
  {
    id: 'signal',
    label: '簇5·同一稳定偏好的纯信号条（汇报先说结论，掺一条用户嘱记）',
    members: [
      {
        slug: 'd1-conclusion-first-a', type: 'feedback', title: '又要求先说结论',
        description: '沟通偏好信号', sources: ['d1-c-comm-a'],
        content: '用户又一次要求汇报先说结论再给过程，嫌铺垫太长。',
      },
      {
        slug: 'd1-conclusion-first-b', type: 'feedback', title: '嘱记：汇报先给结论',
        description: '用户亲口嘱记', sources: ['d1-c-comm-b'], userRequested: true,
        content: '用户亲口嘱记：「记住：跟我汇报永远先给结论，过程放后面。」',
      },
      {
        slug: 'd1-conclusion-first-c', type: 'feedback', title: '第三次不耐烦冗长铺垫',
        description: '沟通偏好信号', sources: ['d1-c-comm-c'],
        content: '用户第三次表达对冗长铺垫的不耐烦，强调要先听结论。',
      },
    ],
  },
];

/** 8 条互不相关的独立条——全部事件型（带独立事实/洞察），「0 误退」的硬判对象 */
const D1_INDEPENDENT: FixtureEpisode[] = [
  {
    slug: 'd1-hike-wugong', type: 'user', title: '五一武功山徒步遇暴雨',
    description: '一次徒步经历', sources: ['d1-c-hike'],
    content: '五一徒步武功山，第二天遇暴雨，全队从发云界提前下撤，走了四小时泥路到龙山村，决定以后雨季不进山。',
  },
  {
    slug: 'd1-perf-review', type: 'user', title: 'Q1 绩效面谈结论',
    description: '主管的具体评价', sources: ['d1-c-perf'],
    content: '第一季度绩效面谈，主管的具体结论是：执行力强、交付稳定，但跨部门沟通偏被动，建议主动发起对齐会。',
  },
  {
    slug: 'd1-father-birthday', type: 'user', title: '父亲六十岁家宴',
    description: '家宴经过', sources: ['d1-c-family'],
    content: '父亲六十岁生日在家办，做了八个菜，姐姐一家从杭州回来，老爷子喝了三两白酒很高兴。',
  },
  {
    slug: 'd1-apartment-hunt', type: 'user', title: '看房三套的比较结论',
    description: '租房决策经过', sources: ['d1-c-house'],
    content: '周末看了三套房：城西的两居离地铁三百米但朝北，城东的开间朝南但贵八百，最后定了城西那套，理由是通勤优先。',
  },
  {
    slug: 'd1-health-check', type: 'user', title: '体检甘油三酯偏高',
    description: '体检具体数值', sources: ['d1-c-health'],
    content: '今年体检甘油三酯 2.8 偏高（参考值上限 1.7），医生建议少油少酒、三个月复查。',
  },
  {
    slug: 'd1-cat-neuter', type: 'user', title: '猫咪绝育当天经过',
    description: '宠物事件', sources: ['d1-c-cat'],
    content: '猫咪绝育手术当天：术前禁食八小时，下午三点做完，回家蔫了两天才恢复进食，伊丽莎白圈戴了一周。',
  },
  {
    slug: 'd1-reunion', type: 'user', title: '大学同学聚会见闻',
    description: '聚会聊到的内容', sources: ['d1-c-reunion'],
    content: '大学同学聚会，老周从程序员转行做了保险经纪，聊了一晚上行业变迁，大家约了以后每半年聚一次。',
  },
  {
    slug: 'd1-new-car', type: 'user', title: '提车第一周体验',
    description: '用车具体感受', sources: ['d1-c-car'],
    content: '提车第一周：实际续航比标称短一成左右，家充桩安装踩了坑——物业要求先出施工方案，前后跑了三趟。',
  },
];

/** 2 条违规条——命中守则「不保存清单」，覆盖淘汰判据一「该退不退」 */
const D1_JUNK: FixtureEpisode[] = [
  {
    slug: 'd1-junk-chitchat', type: 'user', title: '寒暄残片',
    description: '无信息寒暄', sources: ['d1-c-junk-a'],
    content: '在吗？——在的。哈哈。',
  },
  {
    slug: 'd1-junk-oneoff', type: 'user', title: '一次性问答',
    description: '天气问答', sources: ['d1-c-junk-b'],
    content: '问：今天天气怎么样？答：晴，25 度。',
  },
];

// ─── X1/X2/X3 fixture ─────────────────────────────────────

const X1_PROFILE_BEFORE = [
  '## 外观偏好',
  '一直用深色主题，觉得深色护眼。',
  '',
  '## 饮食',
  '不吃香菜。',
  '',
].join('\n');

const X1_EPISODES: FixtureEpisode[] = [
  {
    slug: 'x1-light-1', type: 'user', title: '编辑器主题换浅色',
    description: '外观偏好变化', sources: ['x1-c1'],
    content: '用户提到上周开始把编辑器主题从深色换成了浅色，说白天看着舒服。',
  },
  {
    slug: 'x1-light-2', type: 'user', title: '深色白天反光，全面换浅色',
    description: '外观偏好变化', sources: ['x1-c2'],
    content: '用户说深色主题在白天反光看不清，已经把常用的几个工具都换成了浅色主题。',
  },
  {
    slug: 'x1-light-3', type: 'user', title: '明确要求以后都浅色',
    description: '外观偏好新要求', sources: ['x1-c3'],
    content: '用户明确要求：以后给他做的所有界面默认浅色主题，不要再用深色。',
  },
];

const X2_PROFILE_BEFORE = [
  '## 饮食禁忌',
  '对海鲜过敏，聚餐要避开海鲜。',
  '',
  '## 作息',
  '习惯晚睡，一般凌晨一点后睡。',
  '',
].join('\n');

const X2_CONV = 'x2-peanut-source';
const X2_EPISODES: FixtureEpisode[] = [
  {
    slug: 'x2-seafood-1', type: 'user', title: '海鲜过敏',
    description: '饮食禁忌', sources: [X2_CONV],
    content: '用户对海鲜过敏，一点海鲜都不能碰。',
  },
  {
    slug: 'x2-seafood-2', type: 'user', title: '聚餐避开海鲜',
    description: '饮食禁忌', sources: [X2_CONV],
    content: '用户海鲜过敏，聚餐点菜要避开所有海鲜类。',
  },
];

/** X3 预写档案：17 个小节约 3100 字——稳超 2500 软预算（贴线超几字会让「精简时丢小节」的硬判失去区分度，且 dream 按 trim 后长度判定，裕量必须厚） */
const X3_SECTIONS: Array<{ heading: string; body: string }> = [
  { heading: '## 消费观', body: '买东西的原则是少而精，宁可贵一点买好的用五年，不贪图便宜一年一换。大件消费必做功课，比价之外更看评测里的长期使用反馈，差评比好评看得仔细。对直播间带货免疫，觉得那是冲动消费的流水线。每个月复盘一次账单，固定支出占比心里有数，浮动支出超了两千会问自己值不值。不炒股不炒币，理财只碰指数基金定投，说看不懂的钱不赚。' },
  { heading: '## 通勤出行', body: '日常通勤地铁四十分钟，雷打不动听播客，这是他一天里最稳定的学习时段。打车只在两种情况下：下雨和加班过十点，公司报销额度从来用不完。开车是提车之后才多起来的，周末买菜和短途出游用，工作日绝不开车进城，嫌停车糟心。高铁二等座，飞机经济舱，说省下的差价够吃好几顿好的，但对准点率很敏感，赶时间宁可选早一班的稳妥。' },
  { heading: '## 家务分工', body: '和伴侣的家务分工是做饭归对方、洗碗归他，扫地机器人管地面，他管机器人的清理。每周六上午是大扫除时间，边收拾边听播客，两小时搞定。收纳断舍离派，三个月没用的东西就进待定箱，再三个月没想起就处理掉。冰箱里永远贴着一张便签写着库存，买菜照单来，说这样能少浪费一半食材。' },
  { heading: '## 影音娱乐', body: '追剧速度慢，一季剧能看两个月，喜欢边看边查背景资料，历史剧尤其如此。电影偏爱纪录片和剧情片，漫威系列一部没落下但也一部没记住。音乐通勤听播客、工作听白噪音、运动听说唱，三个场景绝不混用。不太玩手游，唯一的例外是数独，睡前做两题当仪式感。视频会员只续一家，说内容看不完，多开是浪费。' },
  { heading: '## 饮食', body: '口味偏清淡，不吃香菜，辣的能接受微辣，超过中辣就觉得是在受刑而不是吃饭。早餐固定是一杯黑咖啡加两片全麦面包，周末会自己做brunch，拿手的是班尼迪克蛋。外卖常点的就那三四家，不太尝试新店，踩过一次雷之后就变得保守。对食材新鲜度很在意，买菜基本只去楼下那家精品超市，虽然贵一点但放心，肉类一定看生产日期。夏天喜欢喝冷泡茶，冬天喝红茶，奶茶一年喝不了三杯，觉得太甜。聚餐时不挑食但有自己的坚持：香菜和折耳根是底线，除此之外都能商量。' },
  { heading: '## 作息', body: '典型的晚睡晚起，工作日一般凌晨十二点半到一点之间睡，早上八点十分起床，踩点出门，通勤路上听播客。周末会补觉到上午十点多，然后慢悠悠吃个早午餐。午休二十分钟雷打不动，不睡下午就废，同事都知道他中午戴着眼罩趴在工位上的样子。睡前有半小时阅读的习惯，纸质书，不看手机，说看手机越看越精神。偶尔也会因为赶项目熬到两三点，但第二天状态明显差，开会走神，自己知道要尽量避免，所以项目排期时总会给睡眠留出余量。' },
  { heading: '## 工作方式', body: '习惯上午处理需要深度思考的工作，下午开会和回消息，晚上留一小时复盘当天。桌面永远只留当前在做的一件事的窗口，其余全关，浏览器标签页从不超过五个。写方案先列提纲再填肉，改稿至少过三遍，第一遍改结构第二遍改逻辑第三遍改文字。对 deadline 的态度是提前两天完成留缓冲，讨厌踩点交付，也讨厌别人踩点交付给他。跨部门协作偏被动，但答应的事一定会跟进到底，记性不好所以全靠待办清单驱动，清单每天下班前清空一次。' },
  { heading: '## 沟通偏好', body: '汇报永远先给结论，过程放后面，最烦铺垫半天说不到重点，听别人汇报也会直接问「所以结论是什么」。文字沟通偏好短句，一条消息说清一件事，长消息会分段加小标题。开会喜欢有议程的会，没议程的会超过半小时就开始走神，会礼貌地建议下次先发行程。对下属说话直接但对事不对人，复盘时习惯先讲数据再讲感受，批评完一定会给改进路径。不喜欢语音消息，超过三十秒的语音基本转文字看，重要事项要求对方落文字，口头说完不算数。' },
  { heading: '## 审美偏好', body: '设计审美偏极简，讨厌花哨装饰和渐变配色，界面喜欢大留白，觉得信息密度低一点反而高级。家里装修是原木加白色调，家具能少则少，朋友说他家像样板间，他觉得是夸奖。穿衣服基本款为主，黑白灰藏青四个颜色轮着来，一年买不了五件衣服，但每件都挑很久，看重面料和剪裁胜过品牌。对字体的在意程度超过常人，ppt 会为了一个字体的选择纠结半天，觉得字体是气质的地基，最见不得一页 slides 三种字体。' },
  { heading: '## 学习习惯', body: '学新东西先找官方文档通读一遍，再看视频课，最后动手做一个小项目验证，缺了动手环节就觉得没学会。做笔记用卡片式，一个概念一张卡，定期回顾，笔记之间互相链接，攒了三年已经有两千多张。英语靠每天半小时播客维持，主要听技术类和文化类，偶尔跟读练口语。每年会给自己定一个学习主题，今年是分布式系统，去年是葡萄酒入门，前年是基础日语，虽然日语已经荒废但说起那段还是津津有味。学习时手机一定放另一个房间，不然忍不住刷。' },
  { heading: '## 运动', body: '每周打两次羽毛球，固定在周二和周四晚上，水平中等偏上，双打为主，和公司另外两个同事固定搭子。天气好的周末会去徒步，江浙沪周边的线路走了大半，最武功山，雨季不进山是血泪教训，五一那次暴雨下撤走了四小时泥路。不跑步，嫌枯燥，但会快走，晚饭后走四十分钟，边走边听播客，一举两得。体检甘油三酯偏高之后开始注意饮食配合运动，报了一个线上拉伸课，坚持了三个月，肩颈确实松快了不少。' },
  { heading: '## 阅读', body: '年阅读量二十本上下，偏爱非虚构，历史类和科普类各占一半，最近迷上了考古类的书。小说读得少，但喜欢村上春树，《挪威的森林》读过三遍。读书必做划线笔记，读完会写几百字短评存在笔记软件里，年底会翻出来做一次年度书单。kindle 和纸质书各半，长途飞行必带纸质书，说电子屏幕在飞机上看久了眼睛疼。有一个雷打不动的习惯是每年重读一遍《人类简史》，说每次都有新体会，今年的新体会是关于小麦驯化那段。' },
  { heading: '## 旅行', body: '一年两次长途旅行，偏好自然风光胜过城市打卡，去过三次云南，说还要再去，梅里雪山是执念。旅行不做详细攻略，只定大交通和住宿，剩下随缘，觉得计划太满就失去了旅行的意义，最好的体验都是偶遇的。必带清单里有望远镜和一本口袋书，望远镜是用来看鸟的，这两年迷上了观鸟。不喜欢跟团，也不喜欢穷游，住宿预算中等偏上，认为睡得好是旅行体验的地基，吃饭则随意，路边摊也能吃得开心。' },
  { heading: '## 数码设备', body: '手机三年一换，不追新款，换机理由永远是电池不行了。平板用来看文档和追剧，生产力谈不上。耳机有两副，降噪豆通勤用，头戴式在家用，对音质的评价标准就一条：听得出差别但说不出门道。智能手表戴了一年摘了，觉得通知轰炸反而焦虑，但运动记录功能又舍不得，纠结中。家里 nas 存了三年的照片和电影，raid1 双盘备份，丢过一次硬盘之后学的乖。' },
  { heading: '## 社交方式', body: '朋友不多但都是十年以上的老友，社交频率一个月聚一两次，多了觉得累。微信里群聊开了免打扰的占九成，只留家人群和球友群置顶。过生日不喜欢热闹，最舒服的方式是两个人吃顿好的。新朋友主要通过羽毛球和徒步认识，共同的爱好比饭局更能拉近距离。随份子有自己的一套标准，关系远近分得清楚，不打肿脸充胖子。' },
  { heading: '## 宠物', body: '养了一只英短，三岁，已绝育，性格高冷但晚上会主动跳上床睡脚边。猫粮固定在两个牌子之间轮换，零食控制得很严，一周最多两根猫条。铲屎是每天的固定功课，出差时最放心不下的就是它，装了一个摄像头专门看猫，上班摸鱼时就打开看两眼。' },
  { heading: '## 工具偏好', body: '笔记软件换来换去最后固定在 Obsidian，看中的就是本地存储和纯文本，说数据在自己手里才安心。待办清单用手机自带提醒事项，试过很多 gtd 软件都放弃了，觉得工具越简单越容易坚持。浏览器必装去广告插件，主页设置成空白页，书签栏只留五个常用站点。对新工具的态度是先观望三个月，过了热度期还活着才会认真试，被太多昙花一现的工具伤过。键盘是机械键盘茶轴，鼠标换了人体工学鼠之后手腕疼好了大半，显示器是两台4K组双屏。' },
];
const X3_PROFILE_BEFORE = X3_SECTIONS.map((s) => `${s.heading}\n${s.body}`).join('\n\n') + '\n';

const X3_UNRELATED_EPISODE: FixtureEpisode = {
  slug: 'x3-unrelated', type: 'user', title: '下周出差深圳',
  description: '行程安排', sources: ['x3-c1'],
  content: '用户提到下周要去深圳出差三天，参加供应商的年度大会。',
};

// ─── 报告累积 ────────────────────────────────────────────

const reportSections: string[] = [];
function report(title: string, body: string): void {
  reportSections.push(`## ${title}\n\n${body}`);
}

function findBySlug(eps: EpisodeSummary[], slug: string): EpisodeSummary | undefined {
  return eps.find((e) => e.relPath.includes(slug));
}

const D1_ALL_FIXTURE = [...D1_CLUSTERS.flatMap((c) => c.members), ...D1_INDEPENDENT, ...D1_JUNK];

async function main(): Promise<void> {
  debugLogger.setEnabled(true); // D2 幂等计数、合并支撑核查都靠 debug 日志
  await ensureDefaultAgent();
  const backendInfo = await ensureSmokeMemoryBackend();
  if (!backendInfo) {
    console.error('[smoke-scale] backend 未就绪（无 Claude 登录态、也无 coding plan 凭证可注入），跑不了 LLM smoke');
    process.exit(2);
  }
  console.log(`[smoke-scale] backend ready（${backendInfo.mode} / ${backendInfo.model}），seed=${SEED}，造 D1 的 25 条 episode…`);

  const failures: string[] = []; // 硬判红 = 底线失守（定性见报告，不按代码 bug 上报）

  // ═══ D1 规模去重 ═══
  // 交错散布：dream 输入索引按 mtime 倒序——洗牌后第 i 条钉 mtime=now-i*2min，
  // 保证任意同簇成员在索引里不相邻（同簇相邻会把「散落同义配对」简化成「相邻三行比对」）
  const allSlugs = D1_ALL_FIXTURE.map((e) => e.slug);
  const clusterOf = new Map<string, string>();
  for (const c of D1_CLUSTERS) for (const m of c.members) clusterOf.set(m.slug, c.id);
  const rand = mulberry32(SEED);
  let order: string[] = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    order = shuffled(allSlugs, rand);
    const ok = order.every((slug, i) => {
      const c = clusterOf.get(slug);
      if (!c) return true;
      const prev = order[i - 1];
      const next = order[i + 1];
      return clusterOf.get(prev ?? '') !== c && clusterOf.get(next ?? '') !== c;
    });
    if (ok) break;
    if (attempt === 199) throw new Error('洗牌 200 次仍无法满足同簇不相邻（不该发生）');
  }
  const now = Date.now();
  const mtimeOf = new Map(order.map((slug, i) => [slug, now - i * 120_000]));
  for (const ep of D1_ALL_FIXTURE) {
    await makeEpisode(OWNER, ep, mtimeOf.get(ep.slug));
  }

  const d1Before = await listAllEpisodes(OWNER);
  console.log(`[smoke-scale] D1 造了 ${d1Before.length} 条，跑第一次 dream（打真实 LLM）…`);
  const d1Outcome = await runDream({ ownerId: OWNER, currentProjectId: null });
  console.log('[smoke-scale] D1 outcome:', JSON.stringify(d1Outcome));

  const d1After = await listAllEpisodes(OWNER);
  // 硬判一：8 条独立条跑完全部仍 active（不该退的没退）
  for (const ep of D1_INDEPENDENT) {
    const e = findBySlug(d1After, ep.slug);
    if (e?.status !== 'active') failures.push(`D1: 独立事件条被误退 ${ep.slug}（status=${e?.status ?? '消失'}）`);
  }
  // 硬判二：episode 总数不增（铁规 1）
  if (d1After.length > d1Before.length)
    failures.push(`D1: episode 总数增加 ${d1Before.length} → ${d1After.length}（dream 不许新建）`);
  // 硬判三：无 corrected-at（fixture 里没有该纠的条目）
  const d1Corrected = d1After.filter((e) => e.correctedAt);
  for (const e of d1Corrected) failures.push(`D1: 无依据纠错 ${e.relPath}（corrected-at=${e.correctedAt}）`);

  await debugLogger.flushForTest();
  const d1Records = await readLatestDebugRecords(OWNER, 'dream_');
  const d1Tools = countToolCalls(d1Records);

  // D1 人判报告：按簇出块（簇内全部原文 + 各条 status + 幸存条全文）
  const clusterBlocks: string[] = [];
  for (const c of D1_CLUSTERS) {
    const lines: string[] = [`### ${c.label}`, ''];
    for (const m of c.members) {
      const e = findBySlug(d1After, m.slug);
      lines.push(`- ${m.slug}：status=${e?.status ?? '(消失)'}${e?.retiredReason ? `，判据「${e.retiredReason}」` : ''}`);
    }
    lines.push('');
    for (const m of c.members) {
      const e = findBySlug(d1After, m.slug);
      if (!e) continue;
      lines.push(await episodeReportBlock(OWNER, e));
      lines.push('');
    }
    clusterBlocks.push(lines.join('\n'));
  }
  const junkBlock = D1_JUNK.map((j) => {
    const e = findBySlug(d1After, j.slug);
    return `- ${j.slug}：status=${e?.status ?? '(消失)'}${e?.retiredReason ? `，判据「${e.retiredReason}」` : ''}（期望 retired 且判据落在「不保存清单」）`;
  }).join('\n');
  const d1ToolLines = toolCallDetails(d1Records)
    .filter((t) => [...DREAM_WRITE_TOOLS, 'read_memory'].includes(t.name))
    .map((t) => `- ${t.name}(${Object.entries(t.input).map(([k, v]) => `${k}=${JSON.stringify(v)?.slice(0, 120)}`).join(', ')})`)
    .join('\n');
  report(
    'D1 规模去重（硬判 + 人判）',
    `outcome: \`${JSON.stringify(d1Outcome)}\`\nseed=${SEED}；总数 ${d1Before.length} → ${d1After.length}；` +
      `corrected-at ${d1Corrected.length} 条\n` +
      `工具调用计数：${JSON.stringify(d1Tools)}（read_memory 次数是「合并有没有读正文支撑」的旁证）\n\n` +
      `**违规条处置（期望 retire 且判据落在不保存清单）：**\n${junkBlock}\n\n` +
      `**独立条状态（期望全 active）：**\n` +
      D1_INDEPENDENT.map((ep) => `- ${ep.slug}：${findBySlug(d1After, ep.slug)?.status ?? '(消失)'}`).join('\n') +
      `\n\n**按簇出块（原文 + status + 幸存条全文）：**\n\n${clusterBlocks.join('\n\n')}\n\n` +
      `**写工具调用明细：**\n${d1ToolLines || '（无）'}`,
  );

  // ═══ D2 幂等（D1 跑完原样再跑一次） ═══
  console.log('[smoke-scale] D2：原样再跑一次 dream 验幂等…');
  const d2Outcome = await runDream({ ownerId: OWNER, currentProjectId: null });
  console.log('[smoke-scale] D2 outcome:', JSON.stringify(d2Outcome));
  await debugLogger.flushForTest();
  // D2 在插桩启动前就 failed（如 backend 未就绪直接 return）时不产生新 debug 文件——
  // 此时按 mtime 取「最新」会读到 D1 的日志，把 D1 的写操作全算到 D2 头上（假红）。
  // outcome 非 ok 直接记「无法判幂等」，不读数。
  const d2Records = d2Outcome.kind === 'ok' ? await readLatestDebugRecords(OWNER, 'dream_') : [];
  const d2Tools = countToolCalls(d2Records);
  const d2WriteCount = DREAM_WRITE_TOOLS.reduce((n, t) => n + (d2Tools[t] ?? 0), 0);
  report(
    'D2 幂等（第二次 0 次写操作为绿；>0 人判是否第一次未完成的尾巴）',
    `outcome: \`${JSON.stringify(d2Outcome)}\`\n` +
      (d2Outcome.kind !== 'ok'
        ? '本次 dream 未跑成，无法判幂等（不计红不计绿，重跑）'
        : `第二次写操作合计 ${d2WriteCount} 次：${JSON.stringify(d2Tools)}\n` +
          (d2WriteCount > 0
            ? `**非零，人判**：\n${toolCallDetails(d2Records).filter((t) => DREAM_WRITE_TOOLS.includes(t.name)).map((t) => `- ${t.name}(${JSON.stringify(t.input).slice(0, 200)})`).join('\n')}`
            : '0 次 = 幂等成立')),
  );

  // ═══ X1 旧认知被新证据推翻 ═══
  await resetMemory(OWNER);
  await writeUserProfile(OWNER, X1_PROFILE_BEFORE);
  for (const ep of X1_EPISODES) await makeEpisode(OWNER, ep);
  console.log('[smoke-scale] X1：profile 写死「深色主题」+ 3 条浅色 episode，跑 dream…');
  const x1Outcome = await runDream({ ownerId: OWNER, currentProjectId: null });
  console.log('[smoke-scale] X1 outcome:', JSON.stringify(x1Outcome));
  const x1ProfileAfter = await readUserProfile(OWNER);
  const x1EpsAfter = await listAllEpisodes(OWNER);
  // 硬判：无关小节「不吃香菜」原文保留（铁规 5）；episode 总数不增
  if (!x1ProfileAfter.includes('不吃香菜')) failures.push('X1: 无关小节「不吃香菜」丢失（铁规 5 底线）');
  if (x1EpsAfter.length > X1_EPISODES.length)
    failures.push(`X1: episode 总数增加 ${X1_EPISODES.length} → ${x1EpsAfter.length}`);
  await debugLogger.flushForTest();
  const x1Tools = toolCallDetails(await readLatestDebugRecords(OWNER, 'dream_'));
  const x1Writes = x1Tools.filter((t) => t.name === 'write_memory' || t.name === 'edit_memory');
  report(
    'X1 旧认知被新证据推翻（硬判：无关小节保留；人判：profile 有没有更新成浅色）',
    `outcome: \`${JSON.stringify(x1Outcome)}\`\n` +
      `写档案工具调用（判精准 edit 还是整篇覆盖）：\n${x1Writes.map((t) => `- ${t.name} relPath=${JSON.stringify(t.input.relPath ?? '')}`).join('\n') || '（无——3 次全无不作为=处理维度不通过）'}\n\n` +
      `**profile 全文 diff（扫一眼即判）：**\n\`\`\`diff\n${diffLines(X1_PROFILE_BEFORE, x1ProfileAfter)}\n\`\`\``,
  );

  // ═══ X2 错误信息已升格进档案 ═══
  await resetMemory(OWNER);
  // 来源对话原文是「花生过敏」；episode 与 profile 都错记成「海鲜」
  await makeConversation(OWNER, X2_CONV, [
    { role: 'user', text: '我对花生过敏，一点都不能碰' },
    { role: 'assistant', text: '好的，记下了。' },
  ]);
  await writeUserProfile(OWNER, X2_PROFILE_BEFORE);
  for (const ep of X2_EPISODES) await makeEpisode(OWNER, ep);
  console.log('[smoke-scale] X2：episode/profile 错记「海鲜过敏」（原文是花生），跑 dream…');
  const x2Outcome = await runDream({ ownerId: OWNER, currentProjectId: null });
  console.log('[smoke-scale] X2 outcome:', JSON.stringify(x2Outcome));
  const x2EpsAfter = await listAllEpisodes(OWNER);
  const x2ProfileAfter = await readUserProfile(OWNER);
  // 硬判（有意拔高的硬底线，计划组六）：旧词「海鲜」不再出现于 episode（活跃+archived 两层）与 profile。
  // 机械扫描只做预筛：命中的条转人工核语境（纠正条写「原误记海鲜」不算违规）。
  // 扫描范围天然排除 memory/trash/——listEpisodes 只覆盖索引+episodes/archived，够不到回收站。
  const x2Hits: string[] = [];
  for (const e of x2EpsAfter) {
    const full = await readEpisodeFull(OWNER, e.relPath);
    const text = `${e.title}\n${e.description}\n${full?.content ?? ''}`;
    if (text.includes('海鲜')) x2Hits.push(`episode ${e.relPath}（status=${e.status}）`);
  }
  if (x2ProfileAfter.includes('海鲜')) x2Hits.push('user/profile.md');
  if (x2Hits.length > 0)
    failures.push(`X2: 旧词「海鲜」预筛命中（人工核语境后可清除）：${x2Hits.join('；')}`);
  await debugLogger.flushForTest();
  const x2Tools = toolCallDetails(await readLatestDebugRecords(OWNER, 'dream_'));
  const x2Corrects = x2Tools.filter((t) => t.name === 'correct_episode');
  const x2Blocks: string[] = [];
  for (const e of x2EpsAfter) x2Blocks.push(await episodeReportBlock(OWNER, e));
  report(
    'X2 错误信息已升格进档案（硬判：旧词消失；人判：新表述/取证）',
    `outcome: \`${JSON.stringify(x2Outcome)}\`\n` +
      `correct_episode 调用（人判 evidence 是否引原文「花生」）：\n` +
      `${x2Corrects.map((t) => `- oldPath=${JSON.stringify(t.input.oldPath ?? '')} evidence=${JSON.stringify(t.input.evidence ?? '')}`).join('\n') || '（无——纠正未发生，呈 PM）'}\n` +
      `「海鲜」预筛命中：${x2Hits.join('；') || '无'}\n` +
      `档案层写工具：${x2Tools.filter((t) => t.name === 'edit_memory' || t.name === 'write_memory').map((t) => `${t.name}(${JSON.stringify(t.input.relPath ?? '')})`).join('、') || '无'}（纠错应用 edit_memory 不用整篇覆盖）\n\n` +
      `**profile 全文 diff：**\n\`\`\`diff\n${diffLines(X2_PROFILE_BEFORE, x2ProfileAfter)}\n\`\`\`\n\n` +
      `**全部 episode 现状：**\n\n${x2Blocks.join('\n\n')}`,
  );

  // ═══ X3 超预算档案重写 ═══
  await resetMemory(OWNER);
  console.log(`[smoke-scale] X3：预写 profile ${X3_PROFILE_BEFORE.trim().length} 字（软预算 2500）+ 1 条无关 episode，跑 dream…`);
  if (X3_PROFILE_BEFORE.trim().length < 3000)
    throw new Error(`X3 fixture 预写档案 trim 后只有 ${X3_PROFILE_BEFORE.trim().length} 字——裕量太薄，「精简丢小节」硬判失去区分度，fixture 造错`);
  await writeUserProfile(OWNER, X3_PROFILE_BEFORE);
  await makeEpisode(OWNER, X3_UNRELATED_EPISODE); // 没有这条 episode 索引为空，runDream 直接 skipped 空转
  const x3Outcome = await runDream({ ownerId: OWNER, currentProjectId: null });
  console.log('[smoke-scale] X3 outcome:', JSON.stringify(x3Outcome));
  const x3ProfileAfter = await readUserProfile(OWNER);
  const x3EpAfter = findBySlug(await listAllEpisodes(OWNER), X3_UNRELATED_EPISODE.slug);
  // 硬判（条件式）：重写已发生（diff 非空且 ≤2500）→ 既有小节标题一个不少
  const x3Rewritten = x3ProfileAfter.trim() !== X3_PROFILE_BEFORE.trim() && x3ProfileAfter.length <= 2500;
  const headingsBefore = X3_PROFILE_BEFORE.split('\n').filter((l) => l.startsWith('## '));
  const headingsAfter = new Set(x3ProfileAfter.split('\n').filter((l) => l.startsWith('## ')));
  if (x3Rewritten) {
    const lost = headingsBefore.filter((h) => !headingsAfter.has(h));
    if (lost.length > 0) failures.push(`X3: 精简重写丢了小节标题：${lost.join('、')}`);
  }
  report(
    'X3 超预算档案重写（硬判条件式：重写发生则小节标题一个不少）',
    `outcome: \`${JSON.stringify(x3Outcome)}\`\n` +
      `重写是否发生：${x3Rewritten ? `是（${X3_PROFILE_BEFORE.length} → ${x3ProfileAfter.length} 字）` : `否（现长 ${x3ProfileAfter.length} 字；3 次全不发生=机制未执行，记录呈 PM）`}\n` +
      `无关 episode 状态：${x3EpAfter?.status ?? '(消失)'}（动了记异常——它不是本场景的靶子）\n` +
      `小节标题保留：${headingsBefore.map((h) => `${headingsAfter.has(h) ? '✅' : '❌'} ${h}`).join(' ')}\n\n` +
      `**profile 全文 diff（人判关键事实保留度）：**\n\`\`\`diff\n${diffLines(X3_PROFILE_BEFORE, x3ProfileAfter)}\n\`\`\``,
  );

  // ═══ 汇总 + 报告落盘 ═══
  const summary = [
    `# dream 规模去重与冲突处理 smoke 报告（D1/D2 + X1-X3，seed=${SEED}）`,
    '',
    `- 运行时间：${new Date().toISOString()}`,
    `- backend：${backendInfo.mode} / ${backendInfo.model}（结论对应该模型，不外推其他配置）`,
    `- 硬判（底线）：${failures.length === 0 ? '✅ 零失守' : `❌ ${failures.length} 处失守（定性=模型或守则缺口，呈 PM 判读，非代码 bug）：${failures.join('；')}`}`,
    `- 人判样本在各场景节内；跑 3 次后按一致性填计划结论表`,
    '',
    ...reportSections,
  ].join('\n');
  await writeSmokeReport(`memory-scale-seed${SEED}`, summary);

  if (failures.length > 0) {
    console.error('[smoke-scale] ❌ 硬判底线失守（呈 PM，非代码 bug 定性）：\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('[smoke-scale] ✅ 硬判零失守。收敛质量/幂等尾巴/冲突处理见人判报告。');
}

main().catch((e) => {
  console.error('[smoke-scale] 异常：', e);
  process.exit(1);
});
