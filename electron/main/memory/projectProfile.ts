/**
 * Project-profile（projects/<id>/profile.md）读取器
 *
 * 写入统一走 documentIo/writeMemoryDocument（commitWorkfileWrite 内核 + FileHistory）。
 * 旧的 writeProjectProfile / writeInternal / renderProfileBody 已删——那套路径绕过锁，
 * 是 Task 4.5 清理的目标第二写入路径。
 */
import type { MemoryProjectProfile } from '@shared/types';
import { readMarkdownFile } from '../fs/frontmatter';
import { projectProfilePath } from './paths';

const BASIC_HEADER = '## 基本信息';
const CONVENTIONS_HEADER = '## 约定';
const PROGRESS_HEADER = '## 当前进度';

export async function readProjectProfile(
  ownerId: string,
  projectId: string,
): Promise<MemoryProjectProfile> {
  const f = await readMarkdownFile(projectProfilePath(ownerId, projectId));
  if (!f) return { basic: [], conventions: [], progress: '' };
  return parseProfileBody(f.content);
}

// ─── 内部 ─────────────────────────────────────────────────

function parseProfileBody(body: string): MemoryProjectProfile {
  const lines = body.split('\n');
  const basic: string[] = [];
  const conventions: string[] = [];
  let progressLines: string[] = [];
  let mode: 'none' | 'basic' | 'conventions' | 'progress' = 'none';
  for (const raw of lines) {
    const t = raw.trim();
    if (t === BASIC_HEADER) { mode = 'basic'; continue; }
    if (t === CONVENTIONS_HEADER) { mode = 'conventions'; continue; }
    if (t === PROGRESS_HEADER) { mode = 'progress'; continue; }
    if (mode === 'basic') {
      const m = /^\s*-\s+(.+)$/.exec(raw);
      if (m) basic.push(m[1].trim());
    } else if (mode === 'conventions') {
      const m = /^\s*-\s+(.+)$/.exec(raw);
      if (m) conventions.push(m[1].trim());
    } else if (mode === 'progress') {
      progressLines.push(raw);
    }
  }
  while (progressLines.length && progressLines[0].trim() === '') progressLines.shift();
  while (progressLines.length && progressLines[progressLines.length - 1].trim() === '') progressLines.pop();
  return { basic, conventions, progress: progressLines.join('\n') };
}

export { parseProfileBody as __parseProfileBody };
