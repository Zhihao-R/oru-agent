/**
 * skills 目录 watcher —— 外部拖入 / 删除 skill 文件夹时增量对账 + 广播，运行期即时生效（免重启）。
 *
 * 为什么需要：注册表内存 Map 只在启动 initSkillRegistry 扫一次盘；正规安装路径（GitHub /
 * 本地文件夹 / 自创）装完自己 upsert+广播，但用户/别的程序直接往 ~/.oru/skills/ 拖文件夹
 * 绕过了注册。这个 watcher 补上"外部改动 → 热注册"这条路。
 *
 * 设计（照 fs/watcher.ts 的 ProjectWatch 范式，但只盯单一固定目录，故极简）：
 * - 单一 watch(SKILLS_DIR)，事件 → debounce 合并 → reconcileSkillRegistry() → 有增删才广播。
 * - recursive：darwin/win 支持（能听到子目录里 SKILL.md 的写入）；Linux 不支持 → 退化，
 *   靠 skill.list 面板打开时的对账兜底（见 ws/handlers/skill.ts）。
 * - 半拷贝竞态：debounce 吸收 cp -r 的多次事件；reconcile 只注册有合法 SKILL.md 的目录，
 *   SKILL.md 没落齐就本轮跳过，落齐后的下次事件再注册。
 * - 回调捕获创建时的 SkillsWatch 实例（不读模块全局），stop / 替换后的迟到事件直接丢弃。
 */
import { watch, type FSWatcher } from 'node:fs';
import type { ServerEvent } from '@shared/protocol';
import { SKILLS_DIR } from '../runtime/paths';

type Broadcast = (ev: ServerEvent) => void;

// 与 fs/watcher.ts 的 ProjectWatch 取同一防抖窗口——对账幂等，窗口只需盖住 cp -r 的事件抖动即可。
const DEBOUNCE_MS = 250;

type SkillsWatch = {
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  broadcast: Broadcast;
};

let state: SkillsWatch | null = null;

function scheduleReconcile(sw: SkillsWatch): void {
  if (sw.timer) clearTimeout(sw.timer);
  sw.timer = setTimeout(async () => {
    if (state !== sw) return; // 已 stop / 被替换：迟到 flush 丢弃
    sw.timer = null;
    try {
      const { reconcileSkillRegistry } = await import('./registry');
      const { added, removed } = await reconcileSkillRegistry();
      if (added.length > 0 || removed.length > 0) {
        const { broadcastSkillsState } = await import('./chipWriter');
        await broadcastSkillsState(sw.broadcast);
      }
    } catch (e) {
      console.warn('[oru.skills] watcher 对账失败:', e);
    }
  }, DEBOUNCE_MS);
}

/** 启动 skills 目录监听（幂等）。SKILLS_DIR 由启动期 ensureBuiltinSkills 保证已存在。 */
export function startSkillsWatch(broadcast: Broadcast): void {
  if (state) return; // 幂等：已在监听
  // sw 延迟到拿到 watcher 后一次性构造；回调闭包捕获 sw（异步触发，届时已赋值），故不读模块全局。
  let sw: SkillsWatch;
  let watcher: FSWatcher;
  try {
    watcher = watch(
      SKILLS_DIR,
      { persistent: false, recursive: process.platform !== 'linux' },
      () => {
        if (state !== sw) return; // 迟到事件丢弃（已 stop / 被替换）
        scheduleReconcile(sw);
      },
    );
  } catch (e) {
    // 目录不存在 / 平台不支持 recursive：不监听，退化到面板对账 + 重启扫盘
    console.warn('[oru.skills] 无法监听 skills 目录（退化到面板对账 / 重启生效）:', e);
    return;
  }
  sw = { watcher, timer: null, broadcast };
  watcher.on('error', () => {
    if (state === sw) stopSkillsWatch();
  });
  state = sw;
}

/** 停止监听并清理 debounce timer（与 start 成对；App 退出 before-quit 调）。 */
export function stopSkillsWatch(): void {
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.watcher.close();
  state = null;
}

/** 仅测试：当前是否在监听。 */
export function __isWatchingForTest(): boolean {
  return state !== null;
}
