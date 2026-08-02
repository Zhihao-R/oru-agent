/**
 * 对话期 subagent 的 ask_twin 解析器（G72：同步 subagent 提问通道）。
 *
 * 复用异步派工的 askTwinBridge 模式，但脱开后台任务存储——对话期 subagent 没有 task。
 * 两段：
 *   1. 先问主 agent：起一次背景 Twin（runTwinBackground，独立会话、不污染主对话），它带
 *      记忆 / 项目 / 读文件工具，能自行查证的问题就地答掉，用户根本不受打扰（attention.html#Card
 *      「先问主 agent 再升卡」的目标态）。
 *   2. 主 agent 也答不上（调 escalate_to_user）→ 升级为提问卡找用户：复用 ask_user_choice 的
 *      信箱 + 卡片 + WS 回路（options 留空 → 卡片退化成纯自由文本问答），阻塞等用户作答后回填。
 *
 * 第一性：对话期用户在场，不再做 askTwinBridge 的「二次 Twin 翻译用户口语」——那步是给
 * 无人值守的后台 subagent 把口语化答案磨成指令用的；对话期 subagent 就是个 LLM，拿原话即可，
 * 省一次调用。跨后端无关：execute 层 `await resolver`，阻塞→回填天然跨三后端。
 */
import type { AskUserChoiceAnswers, AskUserChoiceQuestion } from '@shared/types';
import { newAskId } from '@shared/ids';
import { runTwinBackground } from '../twinBackgroundQuery';
import { awaitUserChoice, abortUserChoice } from '../../proposals/pendingUserChoice';
import { formatAnswersForModel } from '../agentTools/askUserChoice';

/** 同一次对话期派遣内累计反问上限——超过直接升级给用户，防背景 Twin 空转烧钱。 */
const DEFAULT_MAX_ASK = 5;

type EmitAskUserChoice = (req: { askId: string; questions: AskUserChoiceQuestion[] }) => Promise<void>;

/**
 * 造一个绑定到本次派遣的 askTwinResolver（ask_twin 工具 execute 直接 await 它）。
 * @param deps.askUserChoice 父对话的提问卡广播回调——升级给用户时经它弹卡（与审批卡回流同源）。
 * @param deps.abortSignal    subagent 的中断信号——取消对话时中止背景 Twin 与等待用户。
 */
export function makeSubagentAskTwinResolver(deps: {
  agentId: string;
  /** subagent 的简短意图，拼进背景 Twin 的提问上下文。 */
  description: string;
  askUserChoice: EmitAskUserChoice;
  abortSignal: AbortSignal;
  /** 主对话 conversationId——升级提问的 waiter 归属该对话（唤醒对账按它捞回待答卡）。 */
  conversationId: string;
  maxAsk?: number;
}): (taskId: string, question: string, contextPaths: string[]) => Promise<string> {
  const maxAsk = deps.maxAsk ?? DEFAULT_MAX_ASK;
  let asked = 0;

  return async (taskId, question, contextPaths) => {
    asked += 1;
    const forceEscalate = asked > maxAsk;

    // 升级挂钩：escalate 只做「emit 卡 + 挂 waiter」，真正等答案在下方（与 askTwinBridge 同构）。
    let pending: { questions: AskUserChoiceQuestion[]; promise: Promise<AskUserChoiceAnswers> } | null = null;
    const escalate = async (escQuestion: string): Promise<void> => {
      if (pending) return; // 本次 ask_twin 调用内至多升级一次（背景 Twin escalate 与出错兜底不重复弹卡）
      const askId = newAskId();
      const questions: AskUserChoiceQuestion[] = [{ question: escQuestion, header: '需要你定夺', options: [] }];
      const promise = awaitUserChoice(deps.agentId, deps.conversationId, askId, questions, deps.abortSignal);
      pending = { questions, promise };
      try {
        await deps.askUserChoice({ askId, questions });
      } catch (e) {
        abortUserChoice(askId);
        await promise.catch(() => {});
        pending = null;
        throw e;
      }
    };

    if (forceEscalate) {
      await escalate(`${question}\n\n（本次对话反问已达上限，转你直接定夺）`);
    } else {
      // 派生 abort：subagent 取消 → 中止背景 Twin（runTwinBackground 的空闲看门狗也 abort 它）。
      const ac = new AbortController();
      const onAbort = (): void => ac.abort();
      if (deps.abortSignal.aborted) ac.abort();
      else deps.abortSignal.addEventListener('abort', onAbort, { once: true });
      let r;
      try {
        r = await runTwinBackground({
          agentId: deps.agentId,
          prompt: buildAskPrompt(deps.description, question, contextPaths),
          taskId,
          escalateHandler: async (_t, q) => escalate(q),
          abortController: ac,
        });
      } finally {
        deps.abortSignal.removeEventListener('abort', onAbort);
      }
      if (!pending) {
        // 背景 Twin 直接答上（或出错）——出错也兜底升级给用户，别把内部错误当答案塞回 subagent。
        if (r.isError) await escalate(`${question}\n\n（Oru 后台处理出错：${r.resultText}）`);
        else return r.resultText || '(Oru 没给出回答)';
      }
    }

    // 走到这里必有 pending（要么强制升级、要么 Twin escalate、要么出错兜底升级）。
    try {
      const answers = await pending!.promise;
      return formatAnswersForModel(pending!.questions, answers);
    } catch (e) {
      return `[ESCALATION_ABORTED] ${e instanceof Error ? e.message : String(e)}，请按最稳妥的方案继续，仅做最小改动`;
    }
  };
}

function buildAskPrompt(description: string, question: string, contextPaths: string[]): string {
  const lines = [
    '你正在帮一个执行中的 subagent 解决它遇到的问题。',
    '',
    `subagent 在做：${description}`,
    '',
    'subagent 的提问：',
    question,
    '',
  ];
  if (contextPaths.length > 0) {
    lines.push(
      'subagent 建议你参考的文件（可用 read_file 按需自取，不必全读）：',
      contextPaths.map((p) => `  - ${p}`).join('\n'),
      '',
    );
  }
  lines.push(
    '若你能直接答，简短给出可执行的指令即可。',
    '若这个决策只有用户知道（如「两个同名文件改哪个」），调 escalate_to_user 转给用户。',
  );
  return lines.join('\n');
}
