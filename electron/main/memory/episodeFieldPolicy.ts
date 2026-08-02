/**
 * Episode 字段政策——两条写入通道共用的唯一事实源。
 *
 * 通道一 record_memory（tools.ts 的 JSON schema description，随主对话每轮注入）与
 * 通道二 capture（prompts/capture.ts 的守则，后台一次性用）对同一字段必须给出同一政策。
 * 此前两处各自手写，已经漂移过：description 是逐字誊抄再改两字，userRequested 更是
 * 一处"必填表态"、一处"平时省略"——方向相反。
 *
 * 这里只放**政策句**（两边都要的那部分）。呈现语境各自在外面补：schema description
 * 受每轮 token 成本约束要短，守则可以展开讲后果。别把补充也搬进来，那样又会长回两份。
 */
export const EPISODE_FIELD_POLICY = {
  /** 只放两边共有的那一句；capture 侧的展开（怎么开头、补什么、多长、正反例）留在守则里 */
  content: '事件正文，写结论不写过程',
  title: '事件标题，写完整一句、不带省略号（≤30 字）',
  projectId:
    '必须是**已注册项目的真实 id**（形如 prj_xxx）。没有对得上的已注册项目，' +
    '就用 scope=agent 归通用记忆，别造项目',
  description:
    '一句话（≤30 字），会被未来的召回器读到——让未来的你不打开正文就知道这条讲什么',
  tags:
    '多值标签。夜间整理靠 tag **精确匹配**把同类捞到一起，自造近义词等于不可检索——' +
    '优先复用已出现过的 tag，也别把分类值（feedback / user…）重复成 tag',
  userRequested:
    '必填表态：用户说了"记住 / 帮我记下"这类嘱记话才填 true——亲口陈述一件事不等于嘱记；' +
    '你自发判断值得记填 false。true 的条目落盘带 user-direct 标记，夜间整理会优先保留它的原话',
} as const;
