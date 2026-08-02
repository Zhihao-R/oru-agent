/**
 * 五类 episode 分类的 prompt 片段（英文）
 *
 * record_memory（实时声明）和 capture subagent（周期抓取）共用——
 * 单一真相源，避免两处写法漂移。
 *
 * 直接参考 Claude auto-memory 写法 + 补 Oru 特有的 agent 类。
 */

export { EPISODE_TYPE_PROMPT } from '../prompts/episodeType';
