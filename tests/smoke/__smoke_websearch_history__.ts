/**
 * 验证 v0.4 源头落盘配套的 web 工具语义：
 * 抓回的网页本期落盘到 .tool-cache/，给 LLM 的是 preview + 路径；
 * 老轮和最近一轮发的内容一致——都看 persistedRef.preview，不再依赖 shortSummary。
 *
 * 这里只测核心环节：
 *   1. web_fetch.persistPolicy === 'always'、persistExt === 'md'
 *   2. web_search.persistPolicy 默认（auto）——超阈值自动落盘
 *   3. 工具实例通过 getToolByName 可拿到（启动期注册流程未坏）
 *   4. shouldPersist 在两个工具上的行为符合各自策略
 */
import './__smoke_isolate__';

import { getToolByName } from '../../electron/main/agent/backends/factory';
import { shouldPersist, PERSIST_TOKEN_THRESHOLD } from '../../electron/main/agent/context/persist';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

async function main() {
  // ─── 工具已注册（registerStaticAgentTools 在 isolate helper 里调过）───
  const webFetchTool = getToolByName('web_fetch');
  assert(!!webFetchTool, 'web_fetch 已注册到 factory（registerStaticAgentTools 启动期生效）');

  const webSearchTool = getToolByName('web_search');
  assert(!!webSearchTool, 'web_search 已注册到 factory');

  const readFileTool = getToolByName('read_file');
  assert(!!readFileTool, 'read_file 已注册到 factory（v0.4 新增）');

  // ─── web_fetch：永远落盘 + md 扩展名 ───
  assert(webFetchTool?.persistPolicy === 'always', 'web_fetch persistPolicy === always');
  assert(webFetchTool?.persistExt === 'md', 'web_fetch persistExt === md');

  // ─── web_search：默认（auto）——超阈值才落 ───
  assert(
    webSearchTool?.persistPolicy === undefined || webSearchTool?.persistPolicy === 'auto',
    'web_search persistPolicy 默认（auto）',
    String(webSearchTool?.persistPolicy),
  );

  // ─── read_file：永不落盘 ───
  assert(readFileTool?.persistPolicy === 'never', 'read_file persistPolicy === never');

  // ─── shouldPersist 验证 ───
  // 短 detail：web_fetch 仍落（always），web_search 不落，read_file 永不落
  const shortDetail = '短内容';
  assert(shouldPersist(webFetchTool, shortDetail) === true, 'web_fetch 短 detail 仍落盘（always）');
  assert(shouldPersist(webSearchTool, shortDetail) === false, 'web_search 短 detail 不落盘');
  assert(shouldPersist(readFileTool, shortDetail) === false, 'read_file 短 detail 不落盘');

  // 长 CJK detail（> 2k token）：web_search 也落
  const longDetail = '中'.repeat(1500); // ≈ 2250 token > 2000
  assert(shouldPersist(webSearchTool, longDetail) === true, 'web_search 长 detail 落盘（auto + 超阈值）');
  assert(shouldPersist(readFileTool, longDetail) === false, 'read_file 永不落盘（即便超阈值）');

  // 阈值常量回归
  assert(PERSIST_TOKEN_THRESHOLD === 2000, 'PERSIST_TOKEN_THRESHOLD = 2000');

  const fail = RESULTS.filter((r) => !r.ok);
  if (fail.length > 0) {
    console.error(`\n${fail.length} 项失败`);
    process.exit(1);
  }
  console.log(`\n全部 ${RESULTS.length} 项通过`);
}

void main().catch((e) => {
  console.error('smoke 异常：', e);
  process.exit(1);
});
