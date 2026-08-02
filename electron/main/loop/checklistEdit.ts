/**
 * Loop 中途改标准（v3 保留「改标准·下一轮生效」）——把一次 ChecklistEdit 意图应用到运行中的清单，纯函数。
 *
 * 编辑入队、下一轮边界由内核单点消费（不打断当前轮，避免半轮清单跳变）。三形：
 * - 'add'：加一项（用户亲手加，即时生效）。v2 的出处守卫随「砍出处字段」退场，用户本人即出处、无可核对。
 * - 'remove'：划掉一项。
 * - 'revise'：改一项措辞——原 satisfied 项按新标准解锁重判、回 pending、清 verdict。
 */
import type { ChecklistItem, ChecklistEdit } from '@shared/types';

export type ChecklistEditCtx = {
  /** 新增项的 id 生成器（注入以便测试确定性）。 */
  newId: () => string;
};

export function applyChecklistEdit(
  checklist: ChecklistItem[],
  edit: ChecklistEdit,
  ctx: ChecklistEditCtx,
): ChecklistItem[] {
  switch (edit.op) {
    case 'add':
      return [...checklist, { id: ctx.newId(), statement: edit.item.statement, status: 'pending' }];
    case 'remove':
      return checklist.filter((it) => it.id !== edit.id);
    case 'revise':
      return checklist.map((it) => {
        if (it.id !== edit.id) return it;
        // 改标准 = 这项重新来过：原达标的按新标准可能不再达标，一律解锁回 pending、清旧 verdict。
        return { id: it.id, statement: edit.statement, status: 'pending' };
      });
  }
}
