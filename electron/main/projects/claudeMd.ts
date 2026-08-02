import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export async function loadProjectClaudeMd(projectPath: string): Promise<string> {
  try {
    return await fs.readFile(join(projectPath, 'CLAUDE.md'), 'utf-8');
  } catch {
    return '';
  }
}
