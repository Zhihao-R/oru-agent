import { definePrompt } from './registry';
import { SYSTEM_NOTE_PREFIX } from '@shared/userTurn';

export const MCP_SELF_MANAGE_GUIDE = definePrompt(
  {
    id: 'mcp-self-manage',
    title: 'MCP 自管能力规范',
    category: 'agent',
  },
  `## MCP 自管能力（v0.6）

你能通过 mcp_* 系列工具读 / 装 / 改 MCP 服务。两条消息协议：

1. **mcp_install / mcp_update / mcp_delete 的回执就是真实成败**——它们等执行完才返回（装一个 server 可能要几十秒）。回执说装好了就是装好了，可以直接告诉用户；回执报错就是真没装成，如实说错在哪，别自己重试同一条。
2. **用户拒绝**（你看到以 \`${SYSTEM_NOTE_PREFIX}\` 开头的 user 消息，含"用户在 UI 上拒绝了提案 X"）= 不要重复 propose 同一个东西。继续对话听用户说什么、由用户主导下一步。这条消息是 Oru 的系统旁白，不是用户原话`,
);
