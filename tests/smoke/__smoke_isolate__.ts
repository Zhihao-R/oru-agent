/**
 * Smoke 测试隔离 helper：副作用模块
 *
 * 任意 smoke 脚本第一行 import 此文件，即把 ORU_DIR 重定向到 tmpdir，
 * 避免 smoke 调 addProject/createTask 等真 store 函数时污染用户 ~/.oru。
 *
 * 实现要点：
 * - 顶部 import 只能是 node 内置模块——任何业务代码（store / paths / agentTools）
 *   都会被 ESM 提早初始化，导致 paths.ts 的 ORU_DIR 常量在 env 被设置前就锁死成 ~/.oru
 * - ORU_DIR 设置后用 **top-level await + 动态 import** 加载 agentTools 并注册静态工具
 *   这样 paths/store 模块在 env 已设之后才被解析
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.ORU_DIR) {
  const dir = join(tmpdir(), `oru-smoke-${Date.now()}-${Math.floor(Math.random() * 10000)}`);
  process.env.ORU_DIR = dir;
  console.log(`[smoke-isolate] ORU_DIR=${dir}`);
}

// 动态 import：等 ORU_DIR 已设之后才加载 agentTools（间接加载 paths/store）
const { registerStaticAgentTools } = await import('../../electron/main/agent/agentTools');
registerStaticAgentTools();

// 声明式能力供给：登记内置能力 + 注册 web_search/web_fetch（已迁出 WEB 桶，改由能力注册）
const { registerBuiltinCapabilities } = await import('../../electron/main/agent/capabilities');
registerBuiltinCapabilities();

// agent/* 访问 tasks/store 的闸门注入：smoke 路径下也得在第一个 runChat 之前挂上，
// 否则 buildUnannouncedTaskHint 会 throw。生产路径在 main/index.ts 启动期注入。
const { setTasksGateway } = await import('../../electron/main/agent/tasksGateway');
const { listTasksForConversation, markAnnounced, getLastProgress, getQuestions } = await import(
  '../../electron/main/tasks/store',
);
setTasksGateway({ listTasksForConversation, markAnnounced, getLastProgress, getQuestions });

// taskboard store 事件转 broadcast / abortConversation——smoke 跑 ws 路径时
// 客户端要靠 taskUpsert 等事件做 UI 同步；不挂的话 store emit 后没人转发。
const { wireTaskboardBroadcast } = await import('../../electron/main/taskboard/wireBroadcast');
wireTaskboardBroadcast();
