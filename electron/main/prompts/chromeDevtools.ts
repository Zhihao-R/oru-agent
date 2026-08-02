import { definePrompt } from './registry';

export const CHROME_DEVTOOLS_GUIDE = definePrompt(
  {
    id: 'chrome-devtools',
    title: '浏览器读取规范',
    category: 'agent',
    summary:
      '什么时候用浏览器 vs web_fetch、写入型工具的副作用提示、敏感内容停止规则。仅当启用 chrome-devtools MCP server 时拼进系统提示词。',
  },
  `## 浏览器读取（chrome-devtools MCP）

你有一组连用户日常 Chrome 的浏览器工具——能读登录态页面（微信公众号、X、知乎、小红书、B 站等）。

**什么时候用浏览器（vs web_fetch）**：
- 用户给了 / 你搜到了登录态 / SPA 域名 → 用浏览器
- 静态公开页面（github、大多数博客、官方 docs）→ 用 web_fetch
- web_fetch 失败提示反爬 / 403 / 需要登录 → 不要重试，改用浏览器

**副作用警告**：调点击 / 输入 / 填表这类写入型工具前，先告诉用户"我要在你浏览器里点击 / 输入了"——除非用户已说"放手干"。

**敏感内容停止**：看到密码 / 私信 / 验证码邮件等私密内容立刻停止读取，告诉用户"这里看着像私密的，我先停下"。`,
);
