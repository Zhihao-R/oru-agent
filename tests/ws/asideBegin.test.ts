/**
 * aside.begin 种子落盘（runAsideBegin）：
 * - 种子顺序固定：指代卡（user）→ 短评（assistant）；无 comment 时只一条也能 begin
 * - 指代卡 asideReferent payload 原样落盘、text 为 buildAsideCommentPrompt 回放形态
 * - vision 闸：true 时截图经 saveAttachments 真落盘（conv-images 目录）且可回放；
 *   false 时不落图（attachments 空、目录不存在）
 * - 截图链路坏数据 → 无图降级，begin 不失败（与 §4 截图失败降级同一口径）
 * - 响应带 conversation（kind:'aside'、标题 = referent.label）与种子；
 *   响应 hydrate displayUrl，落盘 JSONL 不带
 *
 * ORU_DIR 范式：顶层先设 env，被测模块全部动态 import（仿 tests/conversations/store.test.ts）。
 * 不 mock 任何模块——store / saveAttachments 的真实落盘正是被测对象的一部分；
 * vision 闸是入参 boolean（router 算好传入），测试直接给值。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-aside-begin-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

// getCurrentOwnerId 真实实现恒返回 'local-user'（单用户模式）
const OWNER = 'local-user';

function convDir(agentId: string): string {
  return join(ORU_DIR, 'users', OWNER, 'conversations', agentId);
}

// 8 字节 PNG magic（\x89PNG\r\n\x1a\n）——足以通过 saveAttachments 的 magic-byte 校验
const PNG_BASE64 = 'iVBORw0KGgo=';

const REFERENT = {
  type: 'message',
  label: '一条配色消息',
  messageId: 'msg-target',
  text: '这页的配色有点闷',
  context: '上一条：配色草稿；下一条：好的我调亮',
} as const;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('runAsideBegin', () => {
  it('带 comment：种子两条且顺序固定（指代卡→短评），payload / text / 落盘正确', async () => {
    const { runAsideBegin } = await import('../../electron/main/ws/aside/begin');
    const { readHistory } = await import('../../electron/main/conversations/store');
    const agentId = 'agent-begin-seeds';

    const { conversation, messages } = await runAsideBegin(
      {
        type: 'aside.begin',
        agentId,
        referent: REFERENT,
        comment: '这配色确实闷，像阴天。',
      },
      false,
    );

    expect(conversation.kind).toBe('aside');
    expect(conversation.title).toBe('一条配色消息');
    expect(conversation.agentId).toBe(agentId);

    expect(messages).toHaveLength(2);
    const [card, comment] = messages;
    expect(card.role).toBe('user');
    expect(card.kind).toBe('aside-referent');
    expect(card.asideReferent).toEqual(REFERENT);
    // text 是给模型的回放形态（与短评 prompt 同一组装）
    expect(card.text).toContain('这页的配色有点闷');
    expect(card.text).toContain('上一条：配色草稿');
    expect(comment.role).toBe('assistant');
    expect(comment.text).toBe('这配色确实闷，像阴天。');
    expect(comment.kind).toBeUndefined();

    // 落盘往返：JSONL 与响应一致（含顺序）
    const persisted = await readHistory(agentId, conversation.id);
    expect(persisted.map((m) => m.id)).toEqual(messages.map((m) => m.id));
    expect(persisted[0].asideReferent).toEqual(REFERENT);
  });

  it('无 comment（用户抢话）：只一条指代卡种子，不补自评', async () => {
    const { runAsideBegin } = await import('../../electron/main/ws/aside/begin');
    const { readHistory } = await import('../../electron/main/conversations/store');
    const agentId = 'agent-begin-no-comment';

    const { conversation, messages } = await runAsideBegin(
      { type: 'aside.begin', agentId, referent: REFERENT },
      false,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe('aside-referent');
    const persisted = await readHistory(agentId, conversation.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].role).toBe('user');
  });

  it('带 commentError（短评失败）：种子补一条空文本 + error 的 assistant 消息，不可重试，落盘往返一致', async () => {
    const { runAsideBegin } = await import('../../electron/main/ws/aside/begin');
    const { readHistory } = await import('../../electron/main/conversations/store');
    const agentId = 'agent-begin-comment-error';

    const { conversation, messages } = await runAsideBegin(
      { type: 'aside.begin', agentId, referent: REFERENT, commentError: '网络断了' },
      false,
    );

    expect(messages).toHaveLength(2);
    const errMsg = messages[1];
    expect(errMsg.role).toBe('assistant');
    expect(errMsg.text).toBe('');
    expect(errMsg.done).toBe(true);
    // retryable:false——主对话不出重试按钮（重说一句话就是天然重试）
    expect(errMsg.error).toEqual({ message: '网络断了', retryable: false });

    const persisted = await readHistory(agentId, conversation.id);
    expect(persisted[1].error).toEqual({ message: '网络断了', retryable: false });
  });

  it('vision 评点模型 + 截图：附件真落盘 conv-images 且可回放；响应 hydrate displayUrl、落盘 JSONL 不带', async () => {
    const { runAsideBegin } = await import('../../electron/main/ws/aside/begin');
    const { readAttachmentBase64 } = await import('../../electron/main/conversations/attachments');
    const agentId = 'agent-begin-vision';

    const { conversation, messages } = await runAsideBegin(
      { type: 'aside.begin', agentId, referent: REFERENT, screenshot: PNG_BASE64 },
      true,
    );

    const card = messages[0];
    expect(card.attachments).toHaveLength(1);
    const att = card.attachments![0];
    expect(att.relPath).toBe(`${conversation.id}-images/${card.id}-1.png`);
    expect(att.mediaType).toBe('image/png');
    // 文件真实存在
    expect(existsSync(join(convDir(agentId), att.relPath))).toBe(true);
    // 历史回放整条链：readAttachmentBase64 能按 relPath 读回原图
    await expect(readAttachmentBase64(agentId, conversation.id, att)).resolves.toBe(PNG_BASE64);
    // 响应出口 hydrate（渲染端直接可显示）
    expect(att.displayUrl).toMatch(/^oru-conv-img:\/\//);
    // 落盘 JSONL 不带 displayUrl（渲染期字段不进磁盘）
    const raw = await fs.readFile(join(convDir(agentId), `${conversation.id}.jsonl`), 'utf-8');
    expect(raw).toContain(att.relPath);
    expect(raw).not.toContain('displayUrl');
  });

  it('非 vision 评点模型 + 截图：指代卡纯文本不落图（attachments 空、无 conv-images 目录）', async () => {
    const { runAsideBegin } = await import('../../electron/main/ws/aside/begin');
    const agentId = 'agent-begin-no-vision';

    const { conversation, messages } = await runAsideBegin(
      { type: 'aside.begin', agentId, referent: REFERENT, screenshot: PNG_BASE64 },
      false,
    );

    expect(messages[0].attachments).toBeUndefined();
    expect(existsSync(join(convDir(agentId), `${conversation.id}-images`))).toBe(false);
  });

  it('截图坏数据（非图片字节）：无图降级，begin 照常成功（链路失败不阻断开口）', async () => {
    const { runAsideBegin } = await import('../../electron/main/ws/aside/begin');
    const agentId = 'agent-begin-bad-shot';

    const { conversation, messages } = await runAsideBegin(
      {
        type: 'aside.begin',
        agentId,
        referent: REFERENT,
        screenshot: Buffer.from('not a png').toString('base64'),
        comment: '短评照常',
      },
      true,
    );

    expect(conversation.kind).toBe('aside');
    expect(messages).toHaveLength(2);
    expect(messages[0].attachments).toBeUndefined();
  });
});
