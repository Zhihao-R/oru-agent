/**
 * list_projects / get_project_detail 的 AgentTool 形态
 *
 * 替代 oruMcpFactory.ts 里 SDK MCP 形态的同名工具。
 * 主对话和背景 Twin 都用得上。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTool } from '@shared/agent/backend';
import { getActiveProjectId } from '../activeProject';
import { getProject, listProjects } from '../../projects/store';
import { getStatus } from '../../git/workflow';

async function buildProjectDetailText(projectId: string): Promise<string> {
  try {
    const p = await getProject(projectId);
    const lines: string[] = [`项目: ${p.name}`, `路径: ${p.path}`];
    const readme = join(p.path, 'README.md');
    if (existsSync(readme)) {
      const r = await fs.readFile(readme, 'utf-8');
      lines.push('', '## README 摘要（前 80 行）', r.split('\n').slice(0, 80).join('\n'));
    }
    if (existsSync(join(p.path, '.git'))) {
      try {
        const s = await getStatus(p.path);
        lines.push(
          '',
          `## git 状态: branch=${s.branch}, ahead=${s.ahead}, behind=${s.behind}, files=${s.files.length}`,
        );
        if (s.files.length > 0) {
          lines.push(
            s.files
              .slice(0, 30)
              .map((f) => `  ${f.status}: ${f.path}`)
              .join('\n'),
          );
        }
      } catch {
        // 非 git 仓或访问失败 - 跳过
      }
    }
    return lines.join('\n');
  } catch (e) {
    return `读取失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function makeListProjectsTool(): AgentTool {
  return {
    name: 'list_projects',
    mutatesEnvironment: false,
    description:
      '列出所有已注册的项目，给出 id / name / path。当用户提到某个项目但你不确定指的是哪个时使用。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute() {
      const { projects, activeId } = await listProjects();
      if (projects.length === 0) {
        return { text: '(没有任何已注册的项目)' };
      }
      const lines = projects.map((p) => {
        const mark = p.id === activeId ? '★ ' : '  ';
        return `${mark}${p.id}  ${p.name}  ${p.path}`;
      });
      return { text: `共 ${projects.length} 个项目（★ 表示当前关注）：\n${lines.join('\n')}` };
    },
  };
}

export function makeGetProjectDetailTool(): AgentTool {
  return {
    name: 'get_project_detail',
    mutatesEnvironment: false,
    description:
      '获取指定项目的详细信息：README 摘要、git status、关键文件。不传 project_id 则用当前关注项目。',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: '项目 id；不传则用当前关注项目',
        },
      },
    },
    async execute(input) {
      const args = input as { project_id?: string };
      const id = args.project_id ?? getActiveProjectId();
      if (!id) {
        return { text: '当前没有关注任何项目' };
      }
      const text = await buildProjectDetailText(id);
      return { text };
    },
  };
}
