/**
 * 运行时态：用户当前在前端"关注"的项目 id
 * - 由 ws router 在收到 `projects.switch` 时更新
 * - hooks 闭包在每次 user prompt submit 时读取
 * - 进程内单例；重启后自动同步为 projects.activeId（在 ensureDefaultAgent 之后）
 */

let activeProjectId: string | null = null;

export function getActiveProjectId(): string | null {
  return activeProjectId;
}

export function setActiveProjectId(id: string | null): void {
  activeProjectId = id;
}
