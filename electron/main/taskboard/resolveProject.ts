/**
 * 把任务的 projectTag（自由文本）解析成实际的 Oru projectId。
 *
 * 匹配优先级（从高到低）：
 *   1. 完全匹配 project.name
 *   2. 大小写忽略匹配 project.name（'oru' ≈ 'Oru'）
 *   3. basename(project.path) 完全或大小写忽略匹配（'demo' 匹配路径 .../Oru-demo）
 *
 * 多歧义（任意一档命中多个项目）→ 返回 null + log warn。
 *   原因：自动选第一个会让用户困惑；让用户手动改 projectTag 更安全。
 *
 * tag 空 / 不命中 → 返回 null（无 log）。
 */
import path from 'node:path';
import type { Project } from '@shared/types';
import { listProjects } from '../projects/store';

export async function resolveProjectByTag(tag: string | undefined): Promise<string | null> {
  const trimmed = tag?.trim();
  if (!trimmed) return null;
  const { projects } = await listProjects();
  return resolve(trimmed, projects);
}

/** 纯函数版本：测试 / 复用方便 */
export function resolve(tag: string, projects: Project[]): string | null {
  // 1. 完全匹配 name
  const exact = projects.filter((p) => p.name === tag);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) {
    console.warn(`[taskboard] resolveProjectByTag: tag '${tag}' 完全匹配多个项目，按无项目处理`);
    return null;
  }

  // 2. 大小写忽略匹配 name
  const lc = tag.toLowerCase();
  const ci = projects.filter((p) => p.name.toLowerCase() === lc);
  if (ci.length === 1) return ci[0].id;
  if (ci.length > 1) {
    console.warn(`[taskboard] resolveProjectByTag: tag '${tag}' 大小写忽略匹配多个项目，按无项目处理`);
    return null;
  }

  // 3. basename 匹配（完全 / 大小写忽略）
  const bn = projects.filter((p) => {
    const base = path.basename(p.path);
    return base === tag || base.toLowerCase() === lc;
  });
  if (bn.length === 1) return bn[0].id;
  if (bn.length > 1) {
    console.warn(`[taskboard] resolveProjectByTag: tag '${tag}' basename 匹配多个项目，按无项目处理`);
    return null;
  }

  return null;
}
