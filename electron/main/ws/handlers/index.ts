/**
 * 命令注册表装配点（D2(a)）：各域 handler 文件导出自己的 map，这里 spread 合并。
 * 类型是完整 `CommandRegistry`（mapped type 强制穷尽）——少接一个协议命令，tsc 在此即报错。
 * 这是注册表取代 167-case switch 的核心收益：「别漏命令」从人肉纪律变成编译期约束。
 */
import type { CommandRegistry } from './types';
import { projectHandlers } from './projects';
import { fileHistoryHandlers } from './fileHistory';
import { fsHandlers } from './fs';
import { tableHandlers } from './table';
import { userHandlers } from './user';
import { gitHandlers } from './git';
import { settingsHandlers } from './settings';
import { mcpHandlers } from './mcp';
import { memoryHandlers } from './memory';
import { providerHandlers } from './providers';
import { promptHandlers } from './prompts';
import { systemHandlers } from './system';
import { agentHandlers } from './agents';
import { modelHandlers } from './models';
import { platformHandlers } from './platform';
import { docHandlers } from './doc';
import { conversationHandlers } from './conversations';
import { scheduledTaskHandlers } from './scheduledTasks';
import { pluginHandlers } from './plugin';
import { skillHandlers } from './skill';
import { taskboardHandlers } from './taskboard';
import { asideHandlers } from './aside';
import { chatHandlers } from './chat';
import { loopHandlers } from './loop';
import { proposalTaskHandlers } from './proposals';
import { artifactHandlers } from './artifact';
import { usageHandlers } from './usage';
import { systemSignalHandlers } from './systemSignals';
import { grantHandlers } from './grants';
import { behaviorPolicyHandlers } from './behaviorPolicy';
import { desktopHandlers } from './desktop';
import { bgCommandHandlers } from './bgCommands';
import { memoryHistoryHandlers } from './memoryHistory';
import { todoHandlers } from './todo';

export const registry: CommandRegistry = {
  ...projectHandlers,
  ...fileHistoryHandlers,
  ...fsHandlers,
  ...tableHandlers,
  ...userHandlers,
  ...gitHandlers,
  ...settingsHandlers,
  ...mcpHandlers,
  ...memoryHandlers,
  ...providerHandlers,
  ...promptHandlers,
  ...systemHandlers,
  ...agentHandlers,
  ...modelHandlers,
  ...platformHandlers,
  ...docHandlers,
  ...conversationHandlers,
  ...scheduledTaskHandlers,
  ...pluginHandlers,
  ...skillHandlers,
  ...taskboardHandlers,
  ...asideHandlers,
  ...chatHandlers,
  ...loopHandlers,
  ...proposalTaskHandlers,
  ...artifactHandlers,
  ...usageHandlers,
  ...systemSignalHandlers,
  ...grantHandlers,
  ...behaviorPolicyHandlers,
  ...desktopHandlers,
  ...bgCommandHandlers,
  ...memoryHistoryHandlers,
  ...todoHandlers,
};
