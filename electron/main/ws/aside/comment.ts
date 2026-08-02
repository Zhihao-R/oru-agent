/**
 * aside.comment：随手评点的 one-shot 短评（技术方案 §5.2）。
 *
 * 无对话、零落盘：组装「人格 + 记忆快照 + 评点规则」的 systemContext 与
 * 「referent 文本/上下文 + 点击位置说明」的 prompt，调一次 one-shot 返回短评。
 * 刻意不用完整 buildStableSystemContext——plugins / deck routing / cadence 那些段
 * 服务于带工具的长对话，对一句短评是噪音（OneShotInput.systemContext 收普通 string，
 * 不经 brand，直接拼没有绕开不变量的问题）。
 *
 * 失败/超时一律静默：本函数吞掉错误返回 null，router 回标准错误包，渲染端静默丢弃——
 * 短评是锦上添花，链路失败不配阻断浮层（PRD 三.3），也不做 abort 管线（克制）。
 */
import type { AsideCommentReq } from '@shared/protocol';
import type { AsideReferent } from '@shared/types';
import { ASIDE_REGION_PHRASES, ORU_SOFTWARE_MAP } from '@shared/asideRegions';
import { newMessageId } from '@shared/ids';
import { getAgent } from '../../agent/store/agents';
import { getBackendFor, OAUTH_FALLBACK_SUPPORTS_VISION } from '../../agent/backends/factory';
import { runOneShotWithTimeout } from '../../agent/backends';
import { instrumentOneShot } from '../../debug/instrument';
import { buildSnapshot } from '../../memory/snapshot';
import { getActiveProjectId } from '../../agent/activeProject';
import { getSettings } from '../../projects/store';

/**
 * 评点规则——aside 短评的行为口径源头；T8 短聊的 extraStableSystemPrompt 与此同口径
 * （短评与短聊是同一个「轻 Oru」形态，两条路径一个口径，技术方案 §7）。
 */
export const ASIDE_COMMENT_RULES = `用户按住 Option 点击了界面上的一块内容，你对它即兴说一句短评。
- 不超过 50 字，口语，一句话，不分点不长篇。
- 必须是「只有看到这块内容才说得出」的观察；观察本身要能接得上话，不必硬加问句。
- 说不出深的就说一句浅而真的短话，不硬凑深度。
- 点到界面控件或纯空隙时，按你的性格吐槽或打趣，不要讲解控件功能。

${ORU_SOFTWARE_MAP}`;

/**
 * aside 短聊行为规则——chat 管线 aside 分支的 extraStableSystemPrompt（技术方案 §7）。
 * 与 ASIDE_COMMENT_RULES 同口径（短评与短聊是同一个「轻 Oru」形态），差异只在形态：
 * 短评是一句话，短聊是几个来回，且短聊多了「能看能查、不动手」的边界——
 * 被要求动手时的引导话术是 §11 点名的体验风险点：要让「转正式对话」听起来是
 * 把事情当真，而不是推脱。
 */
export const ASIDE_CHAT_RULES = `这是一场「随手评点」短聊：用户按住 Option 点了界面上的一块内容，顺手跟你聊起来。
- 短、口语，一两句话一个来回，不分点不长篇。
- 围着被点的那块内容聊，观察要具体；说不出深的就说浅而真的短话，不硬凑深度。
- 聊到界面控件或纯空隙时，按你的性格吐槽或打趣，不要讲解控件功能。
- 这场短聊你能看能查（读文件、搜记忆、看项目信息），帮观察说得更准；但这里不动手改东西。
- 用户想让你动手（改文件、跑任务、做东西）时，把它当好事接住：先简短回应这件事本身（值不值得做、怎么做更好），然后请用户点浮层上的 ↗ 把这段聊天转成正式对话——转过去后你一发话我就有全套工具开干，这里聊过的内容都会原样带过去。不道歉、不说「我做不到」。

${ORU_SOFTWARE_MAP}`;

/** PRD 承诺「几秒内」——超时即放弃（技术方案 §5.2） */
const COMMENT_TIMEOUT_MS = 15_000;

/**
 * 按 referent 各 union 成员组装 prompt：点击位置一句话说明 + 该档自带的文本与上下文
 * （类型与取法一一对应，二期加元素类型 = 加一个 case）。
 */
export function buildAsideCommentPrompt(referent: AsideReferent): string {
  const parts: string[] = [];
  // 场所句（二期 §4 定位层）：区域 id 翻译成人话，放最前——先知身在哪，再看点了啥
  if (referent.region) {
    parts.push(`用户点击的位置在【${ASIDE_REGION_PHRASES[referent.region]}】。`);
  }
  switch (referent.type) {
    case 'selection':
      parts.push('用户按住 Option 点击了选中的一段文字。');
      parts.push(`选中内容：${referent.text}`);
      if (referent.surround) parts.push(`所在上下文：${referent.surround}`);
      break;
    case 'message':
      parts.push('用户按住 Option 点击了对话里的一条消息。');
      parts.push(`消息内容：${referent.text}`);
      parts.push(`前后消息：${referent.context}`);
      break;
    case 'deck-page':
      // pageIndex 从 0 起（deck 页数组下标），展示给模型按人类口径 +1
      parts.push(`用户按住 Option 点击了文稿的第 ${referent.pageIndex + 1} 页。`);
      parts.push(`该页内容：${referent.text}`);
      parts.push(`文稿各页标题：${referent.outline}`);
      break;
    case 'control':
      parts.push('用户按住 Option 点击了界面上的一个控件。');
      if (referent.caption) parts.push(`控件可见文案：${referent.caption}`);
      break;
    case 'blank':
      parts.push('用户按住 Option 点击了界面上的一处空白。');
      if (referent.context) parts.push(`附近内容：${referent.context}`);
      break;
    case 'screen':
      // 唤起对话（系统级）：出了 Oru 窗只剩像素——评点全凭随附截图，焦点是聚光圈那块、
      // 整屏作背景；前台 app 名替代窗口内 region 的场所感（粒度降级，§6）。
      parts.push('用户按住 Option 点击了 Oru 窗口之外的屏幕——可能是别的应用、网页或桌面。');
      if (referent.app) parts.push(`他此刻在用的应用是：${referent.app}。`);
      parts.push('焦点是他点的那一块（截图里聚光圈住的位置），整屏只作背景情境，别滑成泛泛的处境话。');
      break;
    default: {
      // 编译期穷尽检查：二期给 AsideReferent 加 union 成员时，漏写措辞分支在这里直接报错，
      // 而不是静默产出空 prompt（方案 §5.2：二期加元素类型 = 加一个 union 成员）
      const _exhaustive: never = referent;
      void _exhaustive;
    }
  }
  return parts.join('\n');
}

/**
 * asideComment 用途所配模型（评点模型）是否支持视觉。路由口径与 factory 一致：未分配 → 回落
 * twinMain → 仍未分配走 OAuth fallback（支持视觉，单一事实源 OAUTH_FALLBACK_SUPPORTS_VISION）。
 * 已分配但 model 缺失或 supportsVision !== true → false——保守降级为不带图。
 *
 * 导出给 router 作 aside.begin / aside.addReferent 的指代卡落图闸（二期 §3）：
 * 落盘与消费一致——aside 短聊回合喂图的就是评点模型，闸跟着实际消费的模型走。
 */
export async function asideCommentSupportsVision(): Promise<boolean> {
  const settings = await getSettings();
  const assignedModelId =
    settings.modelAssignments.asideComment || settings.modelAssignments.twinMain;
  if (!assignedModelId) return OAUTH_FALLBACK_SUPPORTS_VISION;
  const model = settings.models.find((m) => m.id === assignedModelId);
  return model?.supportsVision === true;
}

/**
 * 跑一次短评。成功返回短评文本；失败/超时返回 null（静默口径见文件头）。
 */
export async function runAsideComment(req: AsideCommentReq): Promise<string | null> {
  try {
    const agent = await getAgent(req.agentId);
    const [backend, snapshot, supportsVision, settings] = await Promise.all([
      getBackendFor('asideComment'),
      buildSnapshot(agent.ownerId, getActiveProjectId()),
      asideCommentSupportsVision(),
      getSettings(),
    ]);
    const systemContext = [agent.systemPromptAppend, snapshot, ASIDE_COMMENT_RULES]
      .filter(Boolean)
      .join('\n\n');
    // 非 vision 模型不带图（点纯空白处会明显退化——已拍板的降级口径，设置项提示选 vision 模型）
    const images =
      supportsVision && req.screenshot
        ? [{ base64: req.screenshot, mediaType: 'image/png' }]
        : undefined;
    // 锚点句只在带图时追加（所以放这里而非 RULES 常量）：模型得知道圆圈=点击区域，
    // 且圈是标注不是界面——真机验证里小圆点 4/4 次被当成界面内容（未读红点）评进短评，
    // 没这句模型还会说「从这张截图看…」打破临场感
    // 「圈」的禁令带正向替代（真机 16 轮里 2 轮说出「圈住/被圈出来」——只说"不要提"
    // 模型还是顺嘴用"圈"指认位置，得告诉它该说什么）
    const prompt = images
      ? `${buildAsideCommentPrompt(req.referent)}\n随附当前界面的截图，高亮圆圈圈出的是用户点击的区域——圆圈是给你的标注，不是界面的一部分。像亲眼看着这块界面一样说话：要指认位置就说「你点的这里」，「圈」「圈出」「截图」这类字眼一个都不要出现。`
      : buildAsideCommentPrompt(req.referent);
    // instrumentOneShot：进调试面板（llmCallSitesGuard 闸门要求）。试探期没有对话，
    // conversationId 用固定伪会话 id——所有短评在面板里归到同一组，好找
    return await instrumentOneShot(
      backend,
      {
        roundId: newMessageId(),
        conversationId: 'aside-probe',
        ownerId: agent.ownerId,
        agentId: agent.id,
        source: 'aside_comment',
        userText: prompt,
      },
      () =>
        runOneShotWithTimeout(
          backend,
          // 思考开关默认关（asideThinking 缺省 = false）：评点要的是几秒内的临场反应（二期 §3）
          {
            prompt,
            systemContext,
            images,
            disableReasoning: settings.asideThinking ? undefined : true,
          },
          COMMENT_TIMEOUT_MS,
        ),
      systemContext,
    );
  } catch (e) {
    // 静默丢弃，但留一行日志给排查（渲染端不展示任何错误）
    console.warn('[aside.comment] 短评失败（静默丢弃）:', e instanceof Error ? e.message : e);
    return null;
  }
}
