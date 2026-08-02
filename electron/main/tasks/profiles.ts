/**
 * 派工模板（ExecutorProfile）
 * 跟 Agent 解耦：未来加新派工角色（reviewer-bot / pm-helper 等）就在这里加
 *
 * 现有：
 * - project-coder：去项目里执行代码改动（读用 SDK Read/Glob/Grep，写走 mcp__oru__ 守卫链工具，S02 收口）
 * - tester：跑测试 / dev server / lint（Read/Glob/Grep/Bash 不写）
 * - inspector：只读分析（git log / find / npm ls 等查询命令）
 */

import { PROJECT_CODER_APPEND } from '../prompts/profileProjectCoder';
import { TESTER_APPEND } from '../prompts/profileTester';
import { INSPECTOR_APPEND } from '../prompts/profileInspector';

export type ExecutorProfile = {
  id: string;
  /** 追加到 systemPrompt 末尾 */
  systemPromptAppend: string;
  /** undefined = 跟随 settingSources 默认 */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** 单 task 内最大 ask_twin 次数；超出强制 escalate_to_user。默认 5 */
  maxAskTwin?: number;
};

export const PROJECT_CODER: ExecutorProfile = {
  id: 'project-coder',
  systemPromptAppend: PROJECT_CODER_APPEND,
};

export const TESTER: ExecutorProfile = {
  id: 'tester',
  allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
  disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
  systemPromptAppend: TESTER_APPEND,
};

export const INSPECTOR: ExecutorProfile = {
  id: 'inspector',
  allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
  disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
  systemPromptAppend: INSPECTOR_APPEND,
};

const profiles: Record<string, ExecutorProfile> = {
  [PROJECT_CODER.id]: PROJECT_CODER,
  [TESTER.id]: TESTER,
  [INSPECTOR.id]: INSPECTOR,
};

export function getProfile(id: string): ExecutorProfile | null {
  return profiles[id] ?? null;
}
