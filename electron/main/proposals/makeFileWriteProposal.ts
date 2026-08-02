/**
 * 构造 FileWriteProposal 的辅助——write_file / edit_file / manage_files(delete) 三工具共用，
 * 收敛 base 字段填法（对齐 makeDeckProposal）。
 */
import { basename } from 'node:path';
import type { FileWriteCaution, FileWriteProposal, GrantScope } from '@shared/types';
import { newProposalId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';

const VERB: Record<FileWriteProposal['mode'], string> = {
  create: '新建',
  overwrite: '覆盖',
  edit: '编辑',
  append: '追加',
  delete: '删除',
  move: '移动',
  rename: '重命名',
};

export function buildFileWriteProposal(args: {
  conversationId: string;
  path: string;
  mode: FileWriteProposal['mode'];
  destDir?: string;
  newName?: string;
  content?: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  appendText?: string;
  diff?: string;
  /**
   * D3 免审（S02）：目标磁盘现状仍是本对话 AI 整篇产出的那一版（isOwnedVersion 判定）——
   * 覆盖它不毁用户内容，视同 create 不强制审批。竞态由锁内 baseline 校验兜住（G88）。
   */
  ownedOverwrite?: boolean;
  /** 带不可逆副作用的写（编码转换）：随覆盖同口径弹卡、卡面出一行警示（决策 7 并入 {overwrite} 授权） */
  caution?: FileWriteCaution;
}): FileWriteProposal {
  const verb = VERB[args.mode];
  // 整类授权（2026-07-30 决策 7）：覆盖可「始终允许」（整类 {overwrite}，编码转换并入——caution
  // 只作卡面警示，不再拦授权；原版有修改历史兜底）；删除发整类 {fileDelete}（走系统回收站可恢复，
  // 默认仍问、用户可自主选择免卡）。D3 免审的覆盖 forceApproval 已为 false，走不到审批。
  const grantable: GrantScope[] | undefined =
    args.mode === 'delete'
      ? [{ kind: 'category', id: 'fileDelete' }]
      : args.mode === 'overwrite' && args.ownedOverwrite !== true
        ? [{ kind: 'overwrite' }]
        : undefined;
  const description =
    args.mode === 'move'
      ? `移动 ${args.path} → ${args.destDir}`
      : args.mode === 'rename'
        ? `重命名 ${args.path} → ${args.newName}`
        : `${verb}文件 ${args.path}`;
  return {
    kind: 'file.write',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: args.conversationId,
    title: `${verb} · ${basename(args.path)}`,
    description,
    createdAt: Date.now(),
    path: args.path,
    mode: args.mode,
    destDir: args.destDir,
    newName: args.newName,
    // work 挡兑现设置页"只在删除/覆盖时问"承诺：删整文件、覆盖已存在文件强制审批；
    // 新建（create）/ 增量编辑（edit）/ 追加（append）不拦——它们都动不了已有内容，
    // 且有实时保存 + 修改历史兜底，是日常放手干的主力，弹卡反成噪音。
    // 覆盖的例外（D3）：磁盘仍是 AI 自己整篇产出的版本 → 免审（承诺保护的是用户的字，不是 AI 的草稿）。
    // 编码转换（caution）是 overwrite 的一种，随覆盖同口径弹卡，卡面另出一行不可逆警示。
    forceApproval:
      args.mode === 'delete' ||
      (args.mode === 'overwrite' && args.ownedOverwrite !== true),
    grantable,
    content: args.content,
    oldString: args.oldString,
    newString: args.newString,
    replaceAll: args.replaceAll,
    appendText: args.appendText,
    diff: args.diff,
    caution: args.caution,
  };
}
