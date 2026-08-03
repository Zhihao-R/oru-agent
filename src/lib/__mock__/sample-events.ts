/**
 * 离线 dev 用的预录 WS 事件序列
 * - 用 ServerEventPayload 类型，保证与协议契约一致
 * - 可在没有后端时手动喂给 chatStore 验证 UI
 */

import type { ServerEventPayload } from '@shared/protocol';

const conversationId = 'cnv_mock_session';
const messageId = 'msg_mock_assistant';
const toolCallId = 'tc_mock_glob';

export const sampleEvents: ServerEventPayload[] = [
  {
    type: 'projects.state',
    projects: [
      {
        id: 'prj_mock_oru',
        ownerId: 'local-user',
        name: 'Oru',
        path: '/Users/oru/Documents/Oru',
        addedAt: Date.now() - 86_400_000,
        lastOpenedAt: Date.now(),
        hasClaudeMd: false,
      },
    ],
    activeId: 'prj_mock_oru',
  },
  {
    type: 'auth.status',
    status: { ready: true, hint: '已检测到 Claude CLI 登录态' },
  },
  {
    type: 'chat.started',
    conversationId,
    messageId,
  },
  {
    type: 'chat.delta',
    conversationId,
    messageId,
    delta: { textChunk: '好的，我先看一下项目里有哪些 markdown 文件。' },
  },
  {
    type: 'chat.toolCall',
    conversationId,
    messageId,
    tool: {
      id: toolCallId,
      name: 'Glob',
      input: { pattern: '**/*.md' },
      status: 'running',
      startedAt: Date.now(),
    },
  },
  {
    type: 'chat.toolResult',
    conversationId,
    messageId,
    result: {
      toolCallId,
      isError: false,
      summary: '匹配到 2 个文件',
      detail: 'PRD.md\nthoughts.md',
    },
  },
  {
    type: 'chat.delta',
    conversationId,
    messageId,
    delta: { textChunk: '\n\n找到了 PRD.md 和 thoughts.md，下一步要我读哪一个？' },
  },
  {
    type: 'chat.done',
    conversationId,
    messageId,
  },
];
