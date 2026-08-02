/**
 * 抓回内容的 prompt-injection 检测。
 *
 * 原则：双锚点——必须配合"忽略/无视/跳过"等动词 + "指令/系统/规则"等系统词
 * 才视作命中，避免误伤正常对话内容（如用户讨论 prompt 工程时引用 "ignore previous instructions"）。
 *
 * 已知绕过类型（接受为 MVP 风险）：同义词替换、零宽字符、编码、隐喻指令、多语种混写。
 * 详见 tech-design §7.2.1。
 */

const INJECTION_PATTERNS: RegExp[] = [
  // 英文：忽略/无视/重写 + (任意修饰词 0~3 个) + 系统词；双锚点
  /(ignore|disregard|override|forget)(?:\s+(?:all|the|your|its|previous|prior|above|original|initial))+\s+(instructions?|prompts?|rules?|system|setup)/i,
  // 英文：角色重写 - "you are (now) (a/an) (任意修饰 0~2 词) 系统词"
  /you\s+are\s+(?:now\s+|always\s+)?(?:a\s+|an\s+)?(?:[a-z]+\s+){0,2}(assistant|gpt|chatbot|ai|model|system|admin)/i,
  // 显式系统标签
  /<\s*(system|sys|admin|instructions?)\s*>/i,
  /\[\s*(system|sys|admin|instructions?)\s*\]/i,
  // 中文：忽略/无视/跳过 + 系统/前面 + 指令/提示 三锚点
  /(忽略|无视|跳过|不要管|抛弃)[^。\n]{0,20}(以上|之前|前面|系统|原本)[^。\n]{0,20}(指令|提示|要求|设定|规则)/,
  // 中文：角色重写
  /(你现在|从现在起|从此以后|接下来你)[^。\n]{0,10}(是|扮演|担任|变成)[^。\n]{0,15}(助手|系统|AI|管理员|GPT|模型)/,
];

export type InjectionCheckResult = {
  detected: boolean;
  /** 命中的关键词片段（仅用于日志和给 LLM 的提示文本） */
  matched?: string;
};

export function checkInjection(text: string): InjectionCheckResult {
  for (const re of INJECTION_PATTERNS) {
    const m = text.match(re);
    if (m) return { detected: true, matched: m[0] };
  }
  return { detected: false };
}
