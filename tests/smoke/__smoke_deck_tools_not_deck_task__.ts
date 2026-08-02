/**
 * __smoke_deck_tools_not_deck_task__ —— 两个看图工具在"非 deck 任务"（无 deckPath）调用时
 * 优雅 isError 拒绝（任务 6 决策 3：toolContext.deckPath 缺则报错，不崩）。
 */
import './__smoke_isolate__';
import type { ToolContext } from '@shared/agent/backend';
import { makeRenderContactSheetTool } from '../../electron/main/agent/agentTools/renderContactSheet';
import { makeViewSlideTool } from '../../electron/main/agent/agentTools/viewSlide';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

const ctxNoDeck = {
  conversationId: 'cnv',
  agentId: 'agt',
  ownerId: 'local-user',
  approvalMode: 'work',
  usage: 'subagentCoder',
  abortSignal: new AbortController().signal,
  // 无 deckPath
} satisfies ToolContext;

async function main(): Promise<void> {
  const cs = makeRenderContactSheetTool();
  const vs = makeViewSlideTool();

  const r1 = await cs.execute({}, ctxNoDeck);
  assert(r1.isError === true, 'render_contact_sheet 无 deckPath → isError', r1.text);
  assert(!r1.images || r1.images.length === 0, 'render_contact_sheet 拒绝时不返图');

  const r2 = await vs.execute({ page: 1 }, ctxNoDeck);
  assert(r2.isError === true, 'view_slide 无 deckPath → isError', r2.text);

  // view_slide 入参校验（有 deckPath 也要拦非法 page）——用假路径，page 非法应在渲染前就 isError
  const ctxWithDeck = { ...ctxNoDeck, deckPath: '/nonexistent/deck' } satisfies ToolContext;
  const r3 = await vs.execute({ page: 0 }, ctxWithDeck);
  assert(r3.isError === true, 'view_slide page<1 → isError（入参校验先于渲染）', r3.text);

  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\nTotal: ${RESULTS.length}, Passed: ${RESULTS.length - failed.length}, Failed: ${failed.length}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('smoke fatal:', e);
  process.exit(1);
});
