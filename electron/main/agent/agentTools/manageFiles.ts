/**
 * manage_files AgentTool —— 文件/文件夹的删除（进回收站，可恢复）、移动、重命名。
 *
 * 为何这三件不交给 bash（决策 5 + S32·G49）：它们都有 bash 给不了的「结构语义」——delete 走系统回收站
 * （≠ rm 永久删）；move/rename 走项目相对的 mutate 内核，含 .md 同名 .assets 一并搬 + 相对引用回写 +
 * 历史时间轴迁移（G93）+ workfile 锁 + 撞名绝不覆盖。交给 bash 的 mv 会丢掉这些。只 emit proposal，
 * 落盘由 executeFileWriteProposal 执行；move/rename 仅支持项目内文件（跨项目/沙盒外文件仍走 bash）。
 */
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import type { StructuredMarkers } from '@shared/agent/structuredMarkers';
import { buildFileWriteProposal } from '../../proposals/makeFileWriteProposal';
import { assertWritableSandbox, SandboxError } from './pathSandbox';
import { proposeOrExecuteFileWrite } from './emitProposal';

const TOOL_DESC = `管理文件/文件夹：删除（进回收站，可恢复）、移动、重命名。

**该用**：用户让你删临时文件、把某个文件挪到别的目录、给文件改个名。删错了能从回收站找回；移动/重命名会连同 .md 的同名 .assets 图片夹一起搬、并保持修改历史不断。

**注意**：
- 移动/重命名**只支持项目内的文件**；项目外（如你自己沙盒里）的文件仍用 bash 的 mv。
- 撞名绝不覆盖（目标已存在会报错）；移动的目标必须是同一项目内的**已存在目录**。

入参：
- action='delete'：path=要删的绝对路径。
- action='move'：path=源绝对路径，destDir=目标目录的绝对路径（同项目内）。
- action='rename'：path=源绝对路径，newName=新文件名（只写名、不含路径分隔符）。`;

export function makeManageFilesTool(): AgentTool {
  return {
    name: 'manage_files',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['delete', 'move', 'rename'], description: '操作类型：delete / move / rename' },
        path: { type: 'string', description: '要操作的文件/文件夹绝对路径' },
        destDir: { type: 'string', description: "action='move' 时的目标目录绝对路径（同项目内的已存在目录）" },
        newName: { type: 'string', description: "action='rename' 时的新文件名（只写名、不含路径分隔符）" },
      },
      required: ['action', 'path'],
    },
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const { action, path, destDir, newName } = (input ?? {}) as {
        action?: string;
        path?: string;
        destDir?: string;
        newName?: string;
      };
      if (action !== 'delete' && action !== 'move' && action !== 'rename') {
        return { isError: true, text: `manage_files: action 须为 delete/move/rename，得到 "${action}"` };
      }
      if (typeof path !== 'string' || path.trim().length === 0) {
        return { isError: true, text: 'manage_files: path 不能为空' };
      }
      if (!isAbsolute(path)) {
        return { isError: true, text: `manage_files: path 必须是绝对路径，得到 "${path}"` };
      }
      if (action === 'move' && (typeof destDir !== 'string' || !isAbsolute(destDir))) {
        return { isError: true, text: `manage_files: move 需要 destDir（目标目录绝对路径），得到 "${destDir}"` };
      }
      if (action === 'rename' && (typeof newName !== 'string' || newName.trim().length === 0)) {
        return { isError: true, text: 'manage_files: rename 需要 newName（新文件名）' };
      }

      try {
        await assertWritableSandbox(path, ctx);
        if (action === 'move') await assertWritableSandbox(destDir!, ctx); // 源与目标都须在可写范围内
      } catch (e) {
        if (e instanceof SandboxError) return { isError: true, text: `manage_files: ${e.message}` };
        throw e;
      }

      if (!existsSync(path)) {
        return { isError: true, text: `manage_files: 路径不存在：${path}` };
      }

      // structured = 「本轮文件变更」的事实标记（PRD 第 7 项）：只随执行成功返回（被拒/只读挡
      // 拦下不带，见 proposeOrExecuteFileWrite）。move/rename 报终点路径并带 from——撞名恒报错、
      // 不静默改名，终点路径在提案时刻即确定。
      if (action === 'delete') {
        const proposal = buildFileWriteProposal({ conversationId: ctx.conversationId, path, mode: 'delete' });
        return proposeOrExecuteFileWrite(ctx, proposal, {
          approvalText: `已递交删除提案：${path}（将移入回收站，可恢复）`,
          resultText: `已移入回收站（可恢复）：${path}`,
          structured: { fileChanges: [{ path, op: 'delete' }] } satisfies StructuredMarkers,
        });
      }

      if (action === 'move') {
        const proposal = buildFileWriteProposal({ conversationId: ctx.conversationId, path, mode: 'move', destDir });
        return proposeOrExecuteFileWrite(ctx, proposal, {
          approvalText: `已递交移动提案：${path} → ${destDir}`,
          resultText: `已移动：${path} → ${destDir}`,
          structured: {
            fileChanges: [{ path: join(destDir!, basename(path)), op: 'move', from: path }],
          } satisfies StructuredMarkers,
        });
      }

      // rename
      const proposal = buildFileWriteProposal({ conversationId: ctx.conversationId, path, mode: 'rename', newName });
      return proposeOrExecuteFileWrite(ctx, proposal, {
        approvalText: `已递交重命名提案：${path} → ${newName}`,
        resultText: `已重命名：${path} → ${newName}`,
        structured: {
          fileChanges: [{ path: join(dirname(path), newName!), op: 'rename', from: path }],
        } satisfies StructuredMarkers,
      });
    },
  };
}
