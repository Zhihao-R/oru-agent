/**
 * PlatformGateway 编排（tech design §4 / §9；S10 统一准入重构）——入站一条消息的全流程：
 * 去重 → 配对/白名单(fail-closed) → 命令插队 → get-or-create(串行链) → admit(统一入队)。
 *
 * 用注入 fake 测编排本身（不碰真 steeringQueue / store / electron）。承重对抗场景：
 * - get-or-create 并发：同来源连发两条只建一个会话（单条串行链 coalesce）
 * - 串行：同来源连发三条 admit 不重叠（忙 / 空闲的序交给统一队列，不再在此轮询双启）
 * - 去重：同 messageId 重投只处理一次
 * - fail-closed：未绑定回「未认证」引导（限频、错码不泄露）；配对码绑定；白名单放行
 * - /stop、/mode 插队：绕过串行链
 * - 处理中表情（§6）：贴表情后登记清除闭包（清除时机在统一回合装配，不在链尾）
 */
import { describe, expect, it, vi } from 'vitest';
import { PlatformGateway, type PlatformGatewayDeps } from '../../electron/main/platform/gateway';
import type { MessageEvent, ProcessingHandle, SessionSource } from '@shared/platform/message';
import type { TriggerOrigin, WhitelistEntry } from '@shared/types';

const tick = () => new Promise((r) => setTimeout(r, 0));

const src = (over: Partial<SessionSource> = {}): SessionSource => ({
  platform: 'feishu',
  chatId: 'oc_1',
  chatType: 'dm',
  userId: 'ou_1',
  raw: {},
  ...over,
});
const evt = (over: Partial<MessageEvent> = {}): MessageEvent => ({
  text: 'hello',
  messageId: `m_${Math.random()}`,
  source: src(),
  ...over,
});

/** 造一套 deps，可覆盖；带 send 收集器、admit 计数、processing 登记收集。 */
function makeDeps(over: Partial<PlatformGatewayDeps> = {}) {
  const sent: Array<{ chatId: string; content: string }> = [];
  const registered: Array<{ origin: TriggerOrigin; clear: () => Promise<void> }> = [];
  let whitelist: WhitelistEntry[] = [];
  let convSeq = 0;
  const createdSources: string[] = [];
  const deps: PlatformGatewayDeps = {
    pairing: { tryConsume: () => false },
    loadWhitelist: async () => whitelist,
    addToWhitelist: async (entry) => {
      if (!whitelist.some((e) => e.id === entry.id)) whitelist = [...whitelist, entry];
    },
    backfillChatId: vi.fn(async (id: string, userId: string, chatId: string) => {
      whitelist = whitelist.map((e) => ((e.id === id || e.id === userId) && !e.chatId ? { ...e, chatId } : e));
    }),
    resolveRemoteAgentId: async () => 'agent-remote',
    resolveLang: async () => 'zh',
    getOrCreateConversation: async (_agentId, s, _title) => {
      const key = `${s.platform}:${s.chatId}`;
      if (!createdSources.includes(key)) {
        createdSources.push(key);
        convSeq += 1;
      }
      return `conv_${s.platform}_${s.chatId}`;
    },
    findConversation: async (_agentId, s) => `conv_${s.platform}_${s.chatId}`,
    abort: vi.fn(),
    setApprovalMode: vi.fn(async () => {}),
    admit: vi.fn(async () => {}),
    send: async (chatId, content) => {
      sent.push({ chatId, content });
      return { ok: true };
    },
    registerProcessing: (origin, clear) => {
      registered.push({ origin, clear });
    },
    ...over,
  };
  return {
    deps,
    sent,
    registered,
    setWhitelist: (l: Array<string | WhitelistEntry>) => {
      whitelist = l.map((x) => (typeof x === 'string' ? { id: x } : x));
    },
    getWhitelist: () => whitelist,
    createCount: () => convSeq,
  };
}

describe('去重', () => {
  it('同 messageId 重投只处理一次', async () => {
    const d = makeDeps();
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    const e = evt({ messageId: 'dup', text: 'hi' });
    await gw.handleMessage(e);
    await gw.handleMessage(e);
    await tick();
    expect(d.deps.admit).toHaveBeenCalledTimes(1);
  });
});

describe('fail-closed 访问控制', () => {
  it('未绑定 → 回「未认证」引导（不 admit）', async () => {
    const d = makeDeps();
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: '你好' }));
    await tick();
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].content).toContain('认证');
    expect(d.deps.admit).not.toHaveBeenCalled();
  });

  it('未绑定引导限频：同一发信人连发只回一次（防刷）', async () => {
    const d = makeDeps();
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: '你好' }));
    await gw.handleMessage(evt({ text: '在吗' }));
    await gw.handleMessage(evt({ text: '111111' })); // 错码也同一句、也被限频
    await tick();
    expect(d.sent).toHaveLength(1);
    expect(d.deps.admit).not.toHaveBeenCalled();
  });

  it('错码与普通消息同回执（不泄露「码对不对」）', async () => {
    const d = makeDeps({ pairing: { tryConsume: (c) => c === '123456' } });
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: '999999' })); // 错码
    await tick();
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].content).toContain('认证'); // 不是「码错了」
    expect(d.deps.admit).not.toHaveBeenCalled();
  });

  it('发对配对码 → 入白名单 + 回成功（不进 agent）', async () => {
    const d = makeDeps({ pairing: { tryConsume: (c) => c === '123456' } });
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: '123456', source: src({ userIdAlt: 'un_1' }) }));
    await tick();
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].content).toContain('绑定成功');
    expect(d.deps.admit).not.toHaveBeenCalled();
    // 存的是 WhitelistEntry：id=stableId、带来源平台/绑定方式/时间；无 resolveDisplayName 则无昵称
    const [entry] = d.getWhitelist();
    expect(entry).toMatchObject({ id: 'un_1', platform: 'feishu', source: 'pairing', chatId: 'oc_1' }); // 绑定即捕获聊天地址
    expect(typeof entry.boundAt).toBe('number');
    expect(entry.displayName).toBeUndefined();
    // 下一条普通消息应被放行
    await gw.handleMessage(evt({ text: 'hi', source: src({ userIdAlt: 'un_1' }) }));
    await tick();
    expect(d.deps.admit).toHaveBeenCalledTimes(1);
  });

  it('绑定时抓到昵称 → 存进 entry.displayName；抓取失败不阻断绑定', async () => {
    const d = makeDeps({
      pairing: { tryConsume: (c) => c === '123456' },
      resolveDisplayName: async () => '张三',
    });
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: '123456', source: src({ userIdAlt: 'un_1' }) }));
    await tick();
    expect(d.getWhitelist()[0]).toMatchObject({ id: 'un_1', displayName: '张三' });

    // 抓取抛错：绑定照常成功，只是无昵称（best-effort）
    const d2 = makeDeps({
      pairing: { tryConsume: (c) => c === '123456' },
      resolveDisplayName: async () => {
        throw new Error('no contact scope');
      },
    });
    const gw2 = new PlatformGateway(d2.deps);
    await gw2.handleMessage(evt({ text: '123456', source: src({ userIdAlt: 'un_2' }) }));
    await tick();
    expect(d2.sent[0].content).toContain('绑定成功');
    expect(d2.getWhitelist()[0]).toMatchObject({ id: 'un_2' });
    expect(d2.getWhitelist()[0].displayName).toBeUndefined();
  });

  it('白名单内 → 放行入队（admit）', async () => {
    const d = makeDeps();
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: 'hi' }));
    await tick();
    expect(d.deps.admit).toHaveBeenCalledTimes(1);
  });

  it('认证人条目缺 chatId → 首次发消息时补录聊天地址（老数据自愈）', async () => {
    const d = makeDeps();
    d.setWhitelist([{ id: 'ou_1' }]); // 旧数据：无 chatId
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: 'hi' })); // src chatId 默认 'oc_1'
    await tick();
    expect(d.deps.backfillChatId).toHaveBeenCalledWith('ou_1', 'ou_1', 'oc_1');
    expect(d.getWhitelist()[0].chatId).toBe('oc_1');
  });

  it('条目已有 chatId → 不再补录（不给每条消息加写盘）', async () => {
    const d = makeDeps();
    d.setWhitelist([{ id: 'ou_1', chatId: 'oc_existing' }]);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: 'hi' }));
    await tick();
    expect(d.deps.backfillChatId).not.toHaveBeenCalled();
  });
});

describe('get-or-create 并发（critical）', () => {
  it('同来源连发两条只建一个会话', async () => {
    const resolves: Array<() => void> = [];
    const d = makeDeps({
      getOrCreateConversation: async (_a, s) => {
        await new Promise<void>((r) => resolves.push(r));
        return `conv_${s.chatId}`;
      },
    });
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    const p1 = gw.handleMessage(evt({ text: 'a' }));
    const p2 = gw.handleMessage(evt({ text: 'b' }));
    await tick();
    // 串行链：第二条不应在第一条 get-or-create 完成前也发起 get-or-create
    expect(resolves).toHaveLength(1);
    resolves[0]();
    await tick();
    expect(resolves).toHaveLength(2); // 第一条完成后第二条才发起
    resolves[1]();
    await Promise.all([p1, p2]);
  });
});

describe('串行（同来源不并发建对话 / 不并发 admit）', () => {
  it('同来源连发三条 admit 不重叠', async () => {
    let active = 0;
    let maxActive = 0;
    const d = makeDeps({
      admit: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await tick();
        active -= 1;
      }),
    });
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await Promise.all([
      gw.handleMessage(evt({ text: '1' })),
      gw.handleMessage(evt({ text: '2' })),
      gw.handleMessage(evt({ text: '3' })),
    ]);
    expect(d.deps.admit).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
  });
});

describe('/stop 命令插队', () => {
  it('/stop 直接 abort，不入队', async () => {
    const d = makeDeps();
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: '/stop', command: { kind: 'stop' } }));
    await tick();
    expect(d.deps.abort).toHaveBeenCalledTimes(1);
    expect(d.deps.admit).not.toHaveBeenCalled();
  });

  it('/stop 在会话尚不存在时 no-op（只查不建，不留空会话、不与串行链竞态）', async () => {
    const createSpy = vi.fn(async (_a: string, s: SessionSource) => `conv_${s.chatId}`);
    const d = makeDeps({
      findConversation: async () => null, // 无既有会话
      getOrCreateConversation: createSpy,
    });
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: '/stop', command: { kind: 'stop' } }));
    await tick();
    expect(d.deps.abort).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled(); // 绝不建会话
  });
});

describe('/mode 远程调挡插队', () => {
  it('/mode danger → 设挡 + 回执，不入队', async () => {
    const d = makeDeps();
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: '/mode danger', command: { kind: 'setMode', mode: 'danger' } }));
    await tick();
    expect(d.deps.setApprovalMode).toHaveBeenCalledWith('agent-remote', 'danger');
    expect(d.deps.admit).not.toHaveBeenCalled();
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].content).toContain('危险挡');
  });

  it('/mode work → 切回工作挡', async () => {
    const d = makeDeps();
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: '/mode work', command: { kind: 'setMode', mode: 'work' } }));
    await tick();
    expect(d.deps.setApprovalMode).toHaveBeenCalledWith('agent-remote', 'work');
    expect(d.sent[0].content).toContain('工作挡');
  });

  it('/mode 参数缺失/非法 → 回用法提示，不设挡', async () => {
    const d = makeDeps();
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: '/mode', command: { kind: 'setMode', mode: null } }));
    await tick();
    expect(d.deps.setApprovalMode).not.toHaveBeenCalled();
    expect(d.deps.admit).not.toHaveBeenCalled();
    expect(d.sent[0].content).toContain('用法');
  });
});

describe('空内容守卫（非文本非图消息不裸起回合）', () => {
  it('空文本无图（贴纸/文件/语音等）→ 回执告知、不入队、不贴表情', async () => {
    const markProcessing = vi.fn(async () => null);
    const d = makeDeps({ markProcessing });
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: '' }));
    await tick();
    expect(d.deps.admit).not.toHaveBeenCalled();
    expect(markProcessing).not.toHaveBeenCalled();
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0].content).toContain('文字和图片');
  });

  it('纯空白文本同样拦下（不被空格骗过）', async () => {
    const d = makeDeps();
    d.setWhitelist(['ou_1']);
    await new PlatformGateway(d.deps).handleMessage(evt({ text: '  \n ' }));
    await tick();
    expect(d.deps.admit).not.toHaveBeenCalled();
    expect(d.sent).toHaveLength(1);
  });

  it('空文本但带图（单发图片）→ 照常入队，imageKeys 与 messageId 透传', async () => {
    const d = makeDeps();
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: '', messageId: 'om_img', imageKeys: ['img_k1'] }));
    await tick();
    expect(d.deps.admit).toHaveBeenCalledTimes(1);
    expect(d.deps.admit).toHaveBeenCalledWith(
      expect.objectContaining({ userText: '', imageKeys: ['img_k1'], platformMessageId: 'om_img' }),
    );
    expect(d.sent).toHaveLength(0); // 不发「看不了」回执
  });
});

describe('处理中表情（§6 跟消息走，清除时机在装配层）', () => {
  const handle: ProcessingHandle = { platform: 'feishu', chatId: 'oc_1', messageId: 'm_x', reactionIds: ['r_1'] };

  it('放行后贴表情（用消息 ID）+ 登记清除闭包（按 origin），gateway 自身不在链尾清', async () => {
    const markProcessing = vi.fn(async () => handle);
    const clearProcessing = vi.fn(async () => {});
    const d = makeDeps({ markProcessing, clearProcessing });
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ messageId: 'm_x', text: 'hi' }));
    await tick();
    expect(markProcessing).toHaveBeenCalledWith('oc_1', 'm_x');
    // 登记了清除闭包，key 为完整 origin；gateway 自己不清（交给统一回合装配消费出站 / 交还时清）
    expect(d.registered).toHaveLength(1);
    expect(d.registered[0].origin).toEqual({ platform: 'feishu', chatId: 'oc_1', platformMessageId: 'm_x' });
    expect(clearProcessing).not.toHaveBeenCalled();
    // 登记的闭包调用即清该 handle
    await d.registered[0].clear();
    expect(clearProcessing).toHaveBeenCalledWith(handle);
  });

  it('贴表情失败（返回 null）→ 不登记、不崩，照常入队', async () => {
    const d = makeDeps({ markProcessing: vi.fn(async () => null), clearProcessing: vi.fn(async () => {}) });
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(evt({ text: 'hi' }));
    await tick();
    expect(d.deps.admit).toHaveBeenCalledTimes(1);
    expect(d.registered).toHaveLength(0);
  });

  it('未认证 / stop 路径不贴表情（非真正入队）', async () => {
    const markProcessing = vi.fn(async () => handle);
    const silent = makeDeps({ markProcessing });
    await new PlatformGateway(silent.deps).handleMessage(evt({ text: '陌生人' }));
    const stop = makeDeps({ markProcessing });
    stop.setWhitelist(['ou_1']);
    await new PlatformGateway(stop.deps).handleMessage(evt({ text: '/stop', command: { kind: 'stop' } }));
    await tick();
    expect(markProcessing).not.toHaveBeenCalled();
  });
});

describe('斜杠命令补全（2026-08-01 plan §3）', () => {
  const cmdEvt = (command: MessageEvent['command'], over: Partial<MessageEvent> = {}) =>
    evt({ text: `/${command!.kind}`, command, ...over });

  describe('/new（串行链层）', () => {
    it('空闲归档 → 回执「已开新篇」', async () => {
      const archive = vi.fn(async () => 'archived' as const);
      const d = makeDeps({ archiveCurrentConversation: archive });
      d.setWhitelist(['ou_1']);
      const gw = new PlatformGateway(d.deps);
      await gw.handleMessage(cmdEvt({ kind: 'new' }));
      expect(archive).toHaveBeenCalledWith('agent-remote', expect.objectContaining({ chatId: 'oc_1' }));
      expect(d.sent.at(-1)!.content).toContain('已开新篇');
    });

    it('忙（占不到闸）→ 拒绝并提示先 /stop，不归档', async () => {
      const archive = vi.fn(async () => 'busy' as const);
      const d = makeDeps({ archiveCurrentConversation: archive });
      d.setWhitelist(['ou_1']);
      const gw = new PlatformGateway(d.deps);
      await gw.handleMessage(cmdEvt({ kind: 'new' }));
      expect(d.sent.at(-1)!.content).toContain('/stop');
      expect(d.sent.at(-1)!.content).not.toContain('已开新篇');
    });

    it('无绑定会话 → 如实回「还没有会话」', async () => {
      const d = makeDeps({ archiveCurrentConversation: vi.fn(async () => 'none' as const) });
      d.setWhitelist(['ou_1']);
      const gw = new PlatformGateway(d.deps);
      await gw.handleMessage(cmdEvt({ kind: 'new' }));
      expect(d.sent.at(-1)!.content).toContain('还没有');
    });

    it('保序（C2 回归）：/new 前的消息归旧篇——admit 先于归档，不换位', async () => {
      const order: string[] = [];
      const d = makeDeps({
        archiveCurrentConversation: vi.fn(async () => {
          order.push('archive');
          return 'archived' as const;
        }),
        admit: vi.fn(async () => {
          order.push('admit');
        }),
      });
      d.setWhitelist(['ou_1']);
      const gw = new PlatformGateway(d.deps);
      // 并发触发：hello 先行入链，/new 必须排在其后
      await Promise.all([
        gw.handleMessage(evt({ text: 'hello' })),
        gw.handleMessage(cmdEvt({ kind: 'new' })),
      ]);
      expect(order).toEqual(['admit', 'archive']);
    });

    it('dep 未注入 → 兜底回「能力未接」，不崩', async () => {
      const d = makeDeps();
      d.setWhitelist(['ou_1']);
      const gw = new PlatformGateway(d.deps);
      await gw.handleMessage(cmdEvt({ kind: 'new' }));
      expect(d.sent.at(-1)!.content).toContain('还没接上');
    });
  });

  describe('/compress（串行链层）', () => {
    const compressCases = [
      { r: { status: 'compressed', fallback: false } as const, expect: '整理成摘要' },
      { r: { status: 'compressed', fallback: true } as const, expect: '丢弃' },
      { r: { status: 'busy' } as const, expect: '等这轮说完' },
      { r: { status: 'empty', emptyReason: 'tooShort' } as const, expect: '太短' },
      { r: { status: 'empty', emptyReason: 'nothingNew' } as const, expect: '没有新内容' },
      { r: { status: 'failed' } as const, expect: '失败' },
    ];
    for (const c of compressCases) {
      it(`四态回执：${JSON.stringify(c.r)} → 「${c.expect}」`, async () => {
        const d = makeDeps({ compressConversation: vi.fn(async () => c.r) });
        d.setWhitelist(['ou_1']);
        const gw = new PlatformGateway(d.deps);
        await gw.handleMessage(cmdEvt({ kind: 'compress' }));
        expect(d.deps.compressConversation).toHaveBeenCalledWith('agent-remote', 'conv_feishu_oc_1');
        expect(d.sent.at(-1)!.content).toContain(c.expect);
      });
    }

    it('无绑定会话 → 「没什么可压」，不动手', async () => {
      const d = makeDeps({
        findConversation: async () => null,
        compressConversation: vi.fn(async () => ({ status: 'compressed', fallback: false }) as const),
      });
      d.setWhitelist(['ou_1']);
      const gw = new PlatformGateway(d.deps);
      await gw.handleMessage(cmdEvt({ kind: 'compress' }));
      expect(d.deps.compressConversation).not.toHaveBeenCalled();
      expect(d.sent.at(-1)!.content).toContain('没什么可压');
    });
  });

  describe('/model（插队层）', () => {
    const models = [
      { id: 'm1', label: 'Claude Sonnet', current: true },
      { id: 'm2', label: 'GPT-5', current: false },
    ];
    it('无参 → 编号清单（标注当前）', async () => {
      const d = makeDeps({ listMainModels: vi.fn(async () => models), setMainModel: vi.fn() });
      d.setWhitelist(['ou_1']);
      const gw = new PlatformGateway(d.deps);
      await gw.handleMessage(cmdEvt({ kind: 'model', index: null, invalid: false }));
      const out = d.sent.at(-1)!.content;
      expect(out).toContain('1. Claude Sonnet');
      expect(out).toContain('2. GPT-5');
      expect(out).toContain('当前');
      expect(out).toContain('下一轮'); // 如实告知：全局 + 下一轮生效
      expect(d.deps.setMainModel).not.toHaveBeenCalled();
    });

    it('合法编号 → 切换写 twinMain，回执如实说「全局 + 下一轮生效」', async () => {
      const setMainModel = vi.fn(async () => 'GPT-5');
      const d = makeDeps({ listMainModels: vi.fn(async () => models), setMainModel });
      d.setWhitelist(['ou_1']);
      const gw = new PlatformGateway(d.deps);
      await gw.handleMessage(cmdEvt({ kind: 'model', index: 2, invalid: false }));
      expect(setMainModel).toHaveBeenCalledWith('m2');
      const out = d.sent.at(-1)!.content;
      expect(out).toContain('GPT-5');
      expect(out).toContain('下一轮');
      expect(out).toContain('全局');
    });

    it('参数非数字 → 回用法（不静默列清单）', async () => {
      const d = makeDeps({ listMainModels: vi.fn(async () => models), setMainModel: vi.fn() });
      d.setWhitelist(['ou_1']);
      const gw = new PlatformGateway(d.deps);
      await gw.handleMessage(cmdEvt({ kind: 'model', index: null, invalid: true }));
      expect(d.sent.at(-1)!.content).toContain('用法');
      expect(d.deps.setMainModel).not.toHaveBeenCalled();
    });

    it('编号超界 → 「编号失效，重新看清单」', async () => {
      const d = makeDeps({ listMainModels: vi.fn(async () => models), setMainModel: vi.fn() });
      d.setWhitelist(['ou_1']);
      const gw = new PlatformGateway(d.deps);
      await gw.handleMessage(cmdEvt({ kind: 'model', index: 9, invalid: false }));
      expect(d.sent.at(-1)!.content).toContain('失效');
      expect(d.deps.setMainModel).not.toHaveBeenCalled();
    });

    it('无注册模型 → 如实说「还没注册」', async () => {
      const d = makeDeps({ listMainModels: vi.fn(async () => []), setMainModel: vi.fn() });
      d.setWhitelist(['ou_1']);
      const gw = new PlatformGateway(d.deps);
      await gw.handleMessage(cmdEvt({ kind: 'model', index: null, invalid: false }));
      expect(d.sent.at(-1)!.content).toContain('还没注册');
    });
  });

  describe('/status（插队层）', () => {
    it('字段齐：绑定的 Oru、挡位、在用模型、忙闲与排队条数', async () => {
      const d = makeDeps({
        statusInfo: vi.fn(async () => ({
          agentName: '小欧',
          approvalMode: 'work' as const,
          modelLabel: 'Claude Sonnet',
          running: true,
          pending: 2,
        })),
      });
      d.setWhitelist(['ou_1']);
      const gw = new PlatformGateway(d.deps);
      await gw.handleMessage(cmdEvt({ kind: 'status' }));
      const out = d.sent.at(-1)!.content;
      expect(out).toContain('小欧');
      expect(out).toContain('工作挡');
      expect(out).toContain('Claude Sonnet');
      expect(out).toContain('2 条排队');
    });

    it('模型未分配 → 如实显示「默认档」；空闲态文案', async () => {
      const d = makeDeps({
        statusInfo: vi.fn(async () => ({
          agentName: '小欧',
          approvalMode: 'readonly' as const,
          modelLabel: null,
          running: false,
          pending: 0,
        })),
      });
      d.setWhitelist(['ou_1']);
      const gw = new PlatformGateway(d.deps);
      await gw.handleMessage(cmdEvt({ kind: 'status' }));
      const out = d.sent.at(-1)!.content;
      expect(out).toContain('默认档');
      expect(out).toContain('空闲');
    });
  });

  it('/help → 回命令清单', async () => {
    const d = makeDeps();
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(cmdEvt({ kind: 'help' }));
    const out = d.sent.at(-1)!.content;
    for (const c of ['/new', '/compress', '/model', '/mode', '/status', '/stop']) {
      expect(out).toContain(c);
    }
  });

  it('chained 命令 dep 抛异常 → 失败回执（不石沉大海；消息已过 dedup，重发会被去重挡）', async () => {
    const d = makeDeps({
      archiveCurrentConversation: vi.fn(async () => {
        throw new Error('disk gone');
      }),
    });
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(cmdEvt({ kind: 'new' }));
    expect(d.sent.at(-1)!.content).toContain('失败');
  });

  it('命令不贴「处理中」表情、不进 admit（回执即反馈，无回合可跟）', async () => {
    const markProcessing = vi.fn(async () => handle);
    const d = makeDeps({ markProcessing, archiveCurrentConversation: vi.fn(async () => 'archived' as const) });
    d.setWhitelist(['ou_1']);
    const gw = new PlatformGateway(d.deps);
    await gw.handleMessage(cmdEvt({ kind: 'new' }));
    expect(markProcessing).not.toHaveBeenCalled();
    expect(d.deps.admit).not.toHaveBeenCalled();
  });
});
