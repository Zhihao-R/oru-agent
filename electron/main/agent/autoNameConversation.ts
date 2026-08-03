/**
 * 对话自动命名——用户首条消息落盘后立即调用，不等回合跑完。
 *
 * 静默吞所有失败（命名是 nice-to-have，绝不能影响主对话）。
 * 两个触发各有专用闸、共用 LLM 内核（runTitleLlm：settings guard + 路由 + 清洗）：
 * - maybeAutoNameConversation（sub）：kind==='sub' + title 仍为默认 + 尚无 assistant
 *   落盘（= 首条 user 消息）；
 * - maybeAutoNameAsideConversation（aside，二期 §5）：首条消息是指代卡 + title 仍是
 *   出生 label（= 卡的 asideReferent.label）——开过口的评点对话一律自动命名，
 *   标题不停在「你点了什么」的原始指代文案上。转正先后不影响：闸不看 kind，
 *   先转正后发了首条评点（kind 已是 sub、标题仍是出生 label）同一函数照常命名。
 * 未配置 conversationTitle 用途时两个触发都直接 return，不走兜底链。
 *
 * 命名只以用户首条消息为输入（aside 额外带指代卡文本），刻意不等 assistant 回复——
 * 首条消息即反映主题，早命名比等回合收尾更即时；命名是独立 one-shot 写 title，
 * 与主回合并发的 appendMessage 走同一 enqueue 串行，写安全。
 */
import { DEFAULT_NEW_CONV_TITLE } from '@shared/types';
import type { ConvStateEvent } from '@shared/protocol';
import {
  getConversation,
  listConversations,
  readHistory,
  renameConversation,
} from '../conversations/store';
import { getSettings } from '../projects/store';
import { getBackendFor, resolveThinkingDisable, runOneShotWithTimeout } from './backends';
import { instrumentOneShot } from '../debug/instrument';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { newMessageId } from '@shared/ids';

/**
 * 命名 LLM 调用超时——比 conversationSummary 短，命名比摘要简单。
 *
 * 30s 不是给"模型 think 慢"留位的，是给网络/上游抖动留位——本路径用
 * disableReasoning:true 关掉了 OR reasoning，命名实测 ~3s 就回（hy3-preview 2.8s）。
 * 如果选了不支持关 reasoning 的模型（非 OR 路径或 OR 不吃 enabled:false 的模型），30s
 * 也是合理硬上限：超过这个数说明选错模型了，UX 上让命名"晚 30s 才出现"不如让它失败。
 */
const AUTO_NAME_TIMEOUT_MS = 30_000;

/** 单段上下文截断长度——命名只需要主题信号，不需要细节 */
const CONTEXT_TRUNCATE_CHARS = 1500;

/** 最终标题长度上限——超出截断，避免撑爆侧栏 */
const TITLE_MAX_CHARS = 24;

export async function maybeAutoNameConversation(args: {
  agentId: string;
  conversationId: string;
  userText: string;
  broadcast: (ev: ConvStateEvent) => void;
}): Promise<void> {
  try {
    // 重读 conv（不信任入参 race）
    const conv = await getConversation(args.agentId, args.conversationId).catch(() => null);
    if (!conv) return;
    if (conv.kind !== 'sub') return;
    if (conv.title !== DEFAULT_NEW_CONV_TITLE) return;

    // 只命名首条 user 消息：数 assistant 消息数，>0 说明不是首条（或首轮已跑出回复），不命名
    const history = await readHistory(args.agentId, args.conversationId);
    const assistantCount = history.filter((m) => m.role === 'assistant').length;
    if (assistantCount > 0) return;

    const title = await runTitleLlm({
      agentId: args.agentId,
      conversationId: args.conversationId,
      prompt: buildPrompt(args.userText),
    });
    if (!title) return;

    // 写入前再读一次，确认用户没在此期间改过名
    const fresh = await getConversation(args.agentId, args.conversationId).catch(() => null);
    if (!fresh || fresh.title !== DEFAULT_NEW_CONV_TITLE) return;

    await renameConversation(args.agentId, args.conversationId, title);

    const conversations = await listConversations(args.agentId);
    args.broadcast({ type: 'conv.state', agentId: args.agentId, conversations });
  } catch (e) {
    // 顶层兜底——任何意外都不能向 chat 流抛
    console.warn(`[autoName] 未预期错误 conv=${args.conversationId}:`, e);
  }
}

/**
 * aside 评点对话的自动命名（二期 §5）——与 sub 触发同挂在 chat.send「首条 user 消息落盘后」
 * 即时触发（aside 浮层打字发评点评走 chat.send，src/aside/overlayMachine.ts），闸完全独立：
 * 首条消息是指代卡 + title 仍是出生 label。命名失败静默，靠 title 闸顺延到下一次打字再试
 * （title 闸保证命成一次就不再动）。
 */
export async function maybeAutoNameAsideConversation(args: {
  agentId: string;
  conversationId: string;
  userText: string;
  broadcast: (ev: ConvStateEvent) => void;
}): Promise<void> {
  try {
    const conv = await getConversation(args.agentId, args.conversationId).catch(() => null);
    if (!conv) return;
    // 廉价前置闸：aside 出生的对话只可能是 'aside' 或转正后的 'sub'——其余 kind
    // （main / taskboard-comment）不必为看首条是不是指代卡而每轮全量读历史
    if (conv.kind !== 'aside' && conv.kind !== 'sub') return;

    // 出生 label 从首条指代卡的 payload 读，不另存字段——首条不是卡（普通对话）直接短路
    const history = await readHistory(args.agentId, args.conversationId);
    const seed = history[0];
    if (seed?.kind !== 'aside-referent' || !seed.asideReferent) return;
    const birthLabel = seed.asideReferent.label;
    if (conv.title !== birthLabel) return; // 用户已改名 / 已命名过——都不动

    const title = await runTitleLlm({
      agentId: args.agentId,
      conversationId: args.conversationId,
      // 只取用户首条消息 + 指代卡文本——「就着什么聊的」比只凭首句更准
      prompt: buildPrompt(args.userText, seed.text),
    });
    if (!title) return;

    // 写入前再读一次，确认用户没在此期间改过名（与 sub 路径同一道 race 防护）
    const fresh = await getConversation(args.agentId, args.conversationId).catch(() => null);
    if (!fresh || fresh.title !== birthLabel) return;

    await renameConversation(args.agentId, args.conversationId, title);

    // 归档分组按需拉取，改名无需广播；已转正的（kind sub）在主列表，走 conv.state 同步
    if (fresh.kind !== 'aside') {
      const conversations = await listConversations(args.agentId);
      args.broadcast({ type: 'conv.state', agentId: args.agentId, conversations });
    }
  } catch (e) {
    console.warn(`[autoName:aside] 未预期错误 conv=${args.conversationId}:`, e);
  }
}

/**
 * 命名 LLM 内核——settings guard + conversationTitle 路由 + 调用 + 清洗，两个触发共用。
 * 返回清洗后的标题；未配置 / 失败 / 产出为空一律 null（调用方静默放弃）。
 */
async function runTitleLlm(p: {
  agentId: string;
  conversationId: string;
  prompt: string;
}): Promise<string | null> {
  // factory 在未配置时**不会抛**——它静默 fallback 到 ClaudeCodeBackend (OAuth 默认)。
  // 这违反"未配置就不命名"的产品决策。这里的 settings guard 是唯一的闸——下方
  // getBackendFor 永远拿得到 backend，所以**别**把这段 guard 删掉或改成 catch fallback。
  const settings = await getSettings();
  if (!settings.modelAssignments.conversationTitle) return null;

  const backend = await getBackendFor('conversationTitle').catch(() => null);
  if (!backend) return null;

  // 思考三态（Track B）：conversationTitle 默认关（命名只要主题信号不要思考过程——开了 thinking
  // 单次要 20-30s、关掉 ~3s），走中央判据；用户想给命名开思考也能在设置里调。
  const raw = await instrumentOneShot(
    backend,
    {
      roundId: newMessageId(),
      conversationId: p.conversationId,
      ownerId: getCurrentOwnerId(),
      agentId: p.agentId,
      source: 'auto_name',
      userText: p.prompt,
    },
    () =>
      runOneShotWithTimeout(
        backend,
        { prompt: p.prompt, disableReasoning: resolveThinkingDisable('conversationTitle', settings) },
        AUTO_NAME_TIMEOUT_MS,
      ),
  ).catch((e) => {
    console.warn(`[autoName] runOneShot 失败 conv=${p.conversationId}:`, e);
    return null;
  });
  if (!raw) return null;

  return sanitize(raw) || null;
}

/**
 * 命名 prompt——英文工程指令（类③，详见 D5）。只以用户首条消息为输入（命名在首条消息
 * 落盘后即时触发，尚无 assistant 回复；主题信号首条已够）。
 * 长度按输出语言给：中文按字、英文按词（信息密度不同，12 汉字 ≠ 12 words；D4），由模型据它
 * 正在用的语言自取，无需代码侧检测语言。"Write the title in the same language the user is
 * using" 是 D4 产出跟对话语言的具体落地。
 */
function buildPrompt(userText: string, referentText?: string): string {
  return [
    'Give this conversation a short, descriptive title.',
    '',
    'Rules:',
    '- Output only the title text — no quotes, no punctuation, no filler like "About" or "Re:".',
    '- Capture the topic; do not restate the user’s words.',
    '- Write the title in the same language the user is using.',
    '- Keep it short: 3–12 characters for Chinese, or 2–4 words for English.',
    '',
    // aside 路径专属：对话是就着界面上被点的这块内容聊起来的（二期 §5）
    ...(referentText
      ? ['The conversation is about this content:', referentText.slice(0, CONTEXT_TRUNCATE_CHARS), '']
      : []),
    'User’s first message:',
    userText.slice(0, CONTEXT_TRUNCATE_CHARS),
    '',
    'Title:',
  ].join('\n');
}

/** 清洗 LLM 输出：trim → 去首尾引号 → 截断长度。返回空串视为放弃。 */
function sanitize(raw: string): string {
  // 取第一行（防 LLM 多吐解释段）
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  // 去首尾常见引号字符（含中英文双单引号 + 直角引号 + 书名号）
  const stripped = firstLine
    .trim()
    .replace(/^[\s"'“”‘’「」『』《》]+|[\s"'“”‘’「」『』《》]+$/g, '')
    .trim();
  return stripped.slice(0, TITLE_MAX_CHARS);
}

