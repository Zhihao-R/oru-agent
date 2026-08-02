import { nanoid } from 'nanoid';

export const newReqId = () => `req_${nanoid(10)}`;
export const newProjectId = () => `prj_${nanoid(10)}`;
export const newMessageId = () => `msg_${nanoid(12)}`;
export const newConversationId = () => `cnv_${nanoid(10)}`;
export const newTaskId = () => `tsk_${nanoid(10)}`;
export const newBoardTaskId = () => `bt_${nanoid(10)}`;
export const newProposalId = () => `prp_${nanoid(10)}`;
export const newScheduledTaskId = () => `sch_${nanoid(10)}`;
/** 「带选项提问」一次 ask 的全局唯一 id；按它挂 waiter，并发多 ask 互不覆盖 */
export const newAskId = () => `ask_${nanoid(10)}`;
export const newQuestionId = () => `qst_${nanoid(10)}`;
/** 断路器一次跳闸的全局唯一 id；按它挂 waiter 等用户「继续放行 / 停止」决定（G01/G04） */
export const newBreakerId = () => `brk_${nanoid(10)}`;
export const newRollbackId = () => `rb_${nanoid(8)}`;
export const newSubagentTaskId = () => `sub_${nanoid(10)}`;
/** 选段「加入对话」引用 chip id */
export const newChatRefId = () => `ref_${nanoid(10)}`;
export const newProviderId = () => `prv_${nanoid(10)}`;
export const newRegisteredModelId = () => `mdl_${nanoid(10)}`;

// Deck 模块（v1）
export const newDeckId = () => `dck_${nanoid(10)}`;
export const newAnnotationId = () => `ann_${nanoid(10)}`;
/** 提交组 id（Submission）——一批标注在"提交"瞬间成组 */
export const newGroupId = () => `grp_${nanoid(10)}`;
/**
 * 把任意标题转成 git 分支安全的 slug
 * Used by: Agent A 的 git workflow 命名 oru/<slug>
 */
export function slugify(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return `task-${nanoid(6)}`;
  const slug = trimmed
    .replace(/[\s/]+/g, '-')
    .replace(/[^a-z0-9一-鿿-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return slug || `task-${nanoid(6)}`;
}
