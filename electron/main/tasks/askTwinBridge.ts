/**
 * 子 agent 中途反问 Twin 的桥
 *
 * 流程：
 * 1. 子 agent 调 ask_twin 工具 → MCP handler 调本模块 askTwin()
 * 2. 切 task 状态 awaiting_twin
 * 3. 起一次 runTwinBackground，prompt 包含 task 上下文 + 子 agent 提问 + contextPaths
 *    - background Twin 可以正常回答（return answer）
 *    - 或调 escalate_to_user 工具 → 触发 escalateHandler → 切 awaiting_user
 *      → 等用户调 task.answerQuestion → 用第二次 background Twin 加工用户回答 → 给子 agent
 * 4. 异常 / 超时 / 累计 5 次 → 自动 escalate_to_user
 * 5. 任何路径完成后切回 running 状态
 */
import { newQuestionId } from '@shared/ids';
import type { TaskQuestion } from '@shared/types';
import type { ServerEventPayload } from '@shared/protocol';
import { runTwinBackground } from '../agent/twinBackgroundQuery';
import { appendQuestion, updateQuestion, updateTaskStatus, getTask, getQuestions } from './store';

type Emit = (ev: ServerEventPayload) => void;

const DEFAULT_MAX_ASK_TWIN = 5;

/** 用户回答 escalate 时的待 resolve 槽位 */
type PendingUserAnswer = {
  resolve: (userOriginalAnswer: string) => void;
  reject: (err: Error) => void;
  originalQuestion: string;
  questionId: string;
  taskId: string;
};
const pendingUserAnswers = new Map<string, PendingUserAnswer>();

/** 当前正在跑的 background Twin query，支持外部 abort（cancelTwinWait 用） */
const inflightBgControllers = new Map<string, AbortController>();

function key(taskId: string, questionId: string): string {
  return `${taskId}:${questionId}`;
}

/**
 * 子 agent 调 ask_twin 时入口
 * - 阻塞等结果（要么 Twin 答、要么用户答）
 * - 返回字符串塞给 ask_twin tool result，子 agent 拿到继续跑
 */
export async function askTwin(args: {
  agentId: string;
  taskId: string;
  question: string;
  contextPaths: string[];
  emit: Emit;
  maxAskTwin?: number;
}): Promise<string> {
  const { agentId, taskId, question, contextPaths, emit } = args;
  const maxAskTwin = args.maxAskTwin ?? DEFAULT_MAX_ASK_TWIN;

  const task = await getTask(taskId);
  if (!task) return `[ASK_TWIN_FAIL] task not found: ${taskId}`;

  // 计数：累计超限直接强制 escalate
  const prior = await getQuestions(taskId);
  const countBefore = prior.length;
  const forceEscalate = countBefore >= maxAskTwin;

  // 1. 写新问题
  const questionId = newQuestionId();
  const q: TaskQuestion = {
    id: questionId,
    taskId,
    question,
    contextPaths,
    askedAt: Date.now(),
    answer: null,
    twinProcessedAnswer: null,
    answeredBy: null,
    answeredAt: null,
  };
  await appendQuestion(taskId, q);
  await updateTaskStatus(taskId, 'awaiting_twin');
  emit({ type: 'task.statusChanged', taskId, status: 'awaiting_twin' });
  emit({ type: 'task.question', taskId, question: q });

  let userAnswerPromise: Promise<string> | null = null;

  const escalateHandler = async (_escTaskId: string, escQuestion: string): Promise<void> => {
    // 给 question 增加最新的"escalate 时的复述"
    await updateQuestion(taskId, questionId, { question: escQuestion });
    await updateTaskStatus(taskId, 'awaiting_user');
    emit({ type: 'task.statusChanged', taskId, status: 'awaiting_user' });
    if (!userAnswerPromise) {
      userAnswerPromise = new Promise<string>((resolve, reject) => {
        pendingUserAnswers.set(key(taskId, questionId), {
          resolve,
          reject,
          originalQuestion: question,
          questionId,
          taskId,
        });
      });
    }
  };

  let twinAnswer: string;
  if (forceEscalate) {
    // 超限直接 escalate，不再问 Twin
    await escalateHandler(taskId, `${question}\n\n（已达本任务 ask_twin 最大次数 ${maxAskTwin}，转你来决定）`);
    twinAnswer = '[FORCED_ESCALATION] 已超过本任务最多 ask_twin 次数，由用户回答';
  } else {
    const prompt = buildAskPrompt(task.proposalTitle, question, contextPaths);
    const bgAc = new AbortController();
    inflightBgControllers.set(taskId, bgAc);
    let r;
    try {
      r = await runTwinBackground({
        agentId,
        prompt,
        taskId,
        escalateHandler,
        abortController: bgAc,
      });
    } finally {
      inflightBgControllers.delete(taskId);
    }
    if (r.isError) {
      // background Twin 出错 / 被 cancelTwinWait abort → 自动 escalate
      await escalateHandler(
        taskId,
        bgAc.signal.aborted
          ? `${question}\n\n（用户主动跳过 Twin，请直接回答）`
          : `${question}\n\n（Twin 后台处理出错: ${r.resultText}）`,
      );
      twinAnswer = bgAc.signal.aborted
        ? '[USER_BYPASSED_TWIN]'
        : `[TWIN_BACKGROUND_ERROR] ${r.resultText}`;
    } else {
      twinAnswer = r.resultText || '(Twin 没给出回答)';
    }
  }

  // 等用户回答（如果 escalate 了）
  let finalAnswer: string;
  let answeredBy: 'twin' | 'user' = 'twin';
  let userOriginalAnswer: string | null = null;
  let twinProcessed: string | null = null;

  if (userAnswerPromise) {
    answeredBy = 'user';
    try {
      userOriginalAnswer = await userAnswerPromise;
    } catch (e) {
      // 用户取消
      const errMsg = e instanceof Error ? e.message : String(e);
      await updateTaskStatus(taskId, 'running');
      emit({ type: 'task.statusChanged', taskId, status: 'running' });
      const aborted: TaskQuestion = {
        ...q,
        answer: null,
        twinProcessedAnswer: `[ABORTED] ${errMsg}`,
        answeredBy: 'user',
        answeredAt: Date.now(),
      };
      await updateQuestion(taskId, questionId, aborted);
      emit({ type: 'task.questionAnswered', taskId, question: aborted });
      return `[ESCALATION_ABORTED] ${errMsg}，请按你最稳妥的方案继续，但仅做最小改动`;
    }
    // 二次 background Twin 加工用户回答
    const translatePrompt =
      `子 agent 提问：${question}\n\n` +
      `用户原话回答：${userOriginalAnswer}\n\n` +
      `请把上面这段口语化的回答翻译成给子 agent 的清晰、可执行的指令。\n` +
      `- 直接输出指令本身，不要包"我建议你..."、"指令是..."这种前缀\n` +
      `- 如果用户回答含糊，结合任务标题"${task.proposalTitle}"做出最贴近用户意图的具体决定\n` +
      `- 简短，不要长篇大论`;
    const r2 = await runTwinBackground({
      agentId,
      prompt: translatePrompt,
      taskId: null,
      escalateHandler: null,
    });
    twinProcessed = r2.resultText || userOriginalAnswer;
    finalAnswer = twinProcessed;
  } else {
    finalAnswer = twinAnswer;
  }

  // 任何路径都切回 running，写 question 答案
  await updateTaskStatus(taskId, 'running');
  emit({ type: 'task.statusChanged', taskId, status: 'running' });
  const answered: TaskQuestion = {
    ...q,
    answer: userOriginalAnswer,
    twinProcessedAnswer: twinProcessed ?? finalAnswer,
    answeredBy,
    answeredAt: Date.now(),
  };
  await updateQuestion(taskId, questionId, answered);
  emit({ type: 'task.questionAnswered', taskId, question: answered });

  return finalAnswer;
}

/**
 * 路由收到 task.answerQuestion 时调用
 * 把用户回答塞回 pending promise，让 askTwin() 接着跑
 */
export function userAnswered(taskId: string, questionId: string, answer: string): boolean {
  const slot = pendingUserAnswers.get(key(taskId, questionId));
  if (!slot) return false;
  pendingUserAnswers.delete(key(taskId, questionId));
  slot.resolve(answer);
  return true;
}

/**
 * 用户在 awaiting_twin 状态下手动取消等 Twin
 * - 中止当前 background Twin query
 * - askTwin() 在 background query 失败的分支里会自动 escalate
 */
export function cancelTwinWait(taskId: string): boolean {
  const ac = inflightBgControllers.get(taskId);
  if (!ac) return false;
  ac.abort();
  return true;
}

/**
 * 任务被 cancel / 失败时，把所有 pending user answer 都 reject 掉，避免 askTwin 永久阻塞
 */
export function abortPendingAnswers(taskId: string, reason: string): void {
  const prefix = `${taskId}:`;
  for (const [k, slot] of pendingUserAnswers.entries()) {
    if (k.startsWith(prefix)) {
      pendingUserAnswers.delete(k);
      slot.reject(new Error(reason));
    }
  }
}

function buildAskPrompt(taskTitle: string, question: string, contextPaths: string[]): string {
  const lines = [
    `你正在帮一个执行子 agent 解决任务过程中遇到的问题。`,
    ``,
    `任务标题：${taskTitle}`,
    ``,
    `子 agent 的提问：`,
    question,
    ``,
  ];
  if (contextPaths.length > 0) {
    lines.push(
      `子 agent 建议你查看的文件路径（你可以用 Read 工具自行读取按需查看，不必全读）：`,
      contextPaths.map((p) => `  - ${p}`).join('\n'),
      ``,
    );
  }
  lines.push(
    `请输出清晰、可执行的指令给子 agent。`,
    `如果你判断这个决策必须由用户来做，调用 escalate_to_user 工具把问题转给用户。`,
    `如果你能直接答，直接答即可，简短，不要长篇大论。`,
  );
  return lines.join('\n');
}
