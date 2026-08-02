/**
 * S02 · D3：整篇覆盖的「整篇产出所有权」免审凭据。
 *
 * 「删除/覆盖时问」保护的是用户的字：文件从 AI 整篇产出以来没有任何他笔碰过，覆盖它
 * 不毁用户内容 → 视同 create 免审（deck / 长文迭代不弹卡洪水）。凭据规则的承重边界：
 * 凭据只在 create/整篇覆盖落盘时建立——对用户内容做一次 edit **建立不了**所有权
 * （否则 AI 免审小改一笔后就能免审整篇覆盖用户文档，attacker 场景）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearConvFileState,
  grantOwnership,
  isOwnedVersion,
  onDelete,
  renewOwnershipAfterEdit,
} from '../../electron/main/agent/conversationFileState';

const CONV = 'conv-d3';
const P = '/tmp/oru-d3-test/artifact.html';

afterEach(() => clearConvFileState(CONV));

describe('D3 免审凭据（整篇产出所有权）', () => {
  it('create/overwrite 落盘建立凭据：磁盘仍是该版 → 免审；被他笔改过 → 失效', () => {
    grantOwnership(CONV, P, 'AI 整篇产出 v1');
    expect(isOwnedVersion(CONV, P, 'AI 整篇产出 v1')).toBe(true);
    expect(isOwnedVersion(CONV, P, '用户改过的版本')).toBe(false);
  });

  it('AI 迭代自己的产物：edit 改动前与凭据相符 → 凭据随之更新到改后版本', () => {
    grantOwnership(CONV, P, 'v1');
    renewOwnershipAfterEdit(CONV, P, 'v1', 'v1-edited');
    expect(isOwnedVersion(CONV, P, 'v1-edited')).toBe(true);
    expect(isOwnedVersion(CONV, P, 'v1')).toBe(false);
  });

  it('attacker：对用户内容 edit 建立不了所有权——免审 edit 后整篇覆盖仍须弹卡', () => {
    // 用户的文档，本对话从未 create/overwrite 过（无凭据）
    renewOwnershipAfterEdit(CONV, P, '用户的文档', '用户的文档 + AI 小改');
    expect(isOwnedVersion(CONV, P, '用户的文档 + AI 小改')).toBe(false);
  });

  it('凭据存在但 edit 改动前已与凭据不符（用户插笔后 AI 又 edit）→ 凭据清除', () => {
    grantOwnership(CONV, P, 'v1');
    renewOwnershipAfterEdit(CONV, P, '用户插笔后的内容', '用户插笔后的内容 + AI 改');
    expect(isOwnedVersion(CONV, P, '用户插笔后的内容 + AI 改')).toBe(false);
  });

  it('delete / 清对话 → 凭据一并清', () => {
    grantOwnership(CONV, P, 'v1');
    onDelete(CONV, P);
    expect(isOwnedVersion(CONV, P, 'v1')).toBe(false);

    grantOwnership(CONV, P, 'v2');
    clearConvFileState(CONV);
    expect(isOwnedVersion(CONV, P, 'v2')).toBe(false);
  });
});

describe('D3 凭据的换行归一口径（review n3）', () => {
  it('模型产物带 CRLF、磁盘回读为 LF 归一 → 凭据仍命中（不静默失效）', () => {
    grantOwnership(CONV, P, 'line1\r\nline2\r\n'); // 模型原文（CRLF）
    expect(isOwnedVersion(CONV, P, 'line1\nline2\n')).toBe(true); // readWithMeta 归一后的磁盘内容
  });
});
