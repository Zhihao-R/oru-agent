import { definePrompt } from './registry';

export const WEB_SEARCH_PROMPT = definePrompt(
  {
    id: 'web-search',
    title: '上网搜索规范',
    category: 'agent',
    summary:
      '什么时候用 web_search / web_fetch、什么时候别用、引用规范。仅当 webSearch.enabled=true 时拼进系统提示词。',
  },
  `## 上网

涉及最新事件 / 具体事实 / 用户明说"查一下"时，用 web_search；拿到候选 URL 后挑 1-5 个用 web_fetch 抓详情。

**用户在跟你讨论自己项目里的代码 / md / 想法——别上网验证**（这条对 web_search、web_fetch、浏览器工具都适用，直接信用户）。

**引用规范**：任何使用了 web_search / web_fetch 或浏览器工具的回答，末尾必须有 \`来源：[1] [2] ...\`（编号 + URL）——没有引用就不算完整回答。

工具具体使用规范（该用 / 别用 / 失败怎么办）看 web_search 和 web_fetch 的 description。`,
);
