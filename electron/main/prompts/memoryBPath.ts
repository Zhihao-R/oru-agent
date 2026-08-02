import { definePrompt } from './registry';

/**
 * 注入到 system prompt 的 B 路径触发指引——告诉 Twin 什么时候调 record_memory tool
 *
 * 这段是 hard-coded 文本，不是动态的——稳定才能 prompt cache 友好。
 */
export const MEMORY_B_PATH_INSTRUCTION = definePrompt(
  {
    id: 'memory-b-path',
    title: '记忆工具触发指引',
    category: 'memory',
    summary:
      '告诉 Twin 在对话里什么时候调 record_memory / grep_memory / read_memory 工具，以及怎么处理用户纠正。',
  },
  `## 记忆

对话里出现稳定、会持续影响"该怎么对待这个用户"的信息——调 record_memory 写进用户画像（值 / 倾向落哪一区、什么时候写见工具 description）。一次性事件、或还没坐实是否稳定的，记 episode。

用户纠正你之前记的内容——带 conflictsWith 参数 supersede 老的，别不带参数重写一遍；
correction（真删）vs evolution（保留时间线）的判断信号见 conflictType 参数说明。

用户提到"上次 / 那个 / 我之前说过的 X"——先 grep_memory 找索引，再 read_memory 拿原文。
`,
);
