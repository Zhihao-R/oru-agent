/**
 * 候选简介块 —— 喂给召回挑选器「选的时候每条只给一行简介」（recall tech-design §1.1 / §1.2）
 *
 * 复用 snapshot 的 scanAllActiveEpisodes（元数据扫描，与结构粗筛同一套元数据），加一个 formatter：
 * 一行一条 = `id + 硬维度(类别·时间) + 一行简介`。挑选器据此选相关，selected id = compressedPath
 * （resolveToFullRelPath 可解回全路径取全文）。简介小，几百条一次喂得下小模型。
 */
import { scanAllActiveEpisodes, type EpisodeFile } from '../snapshot';
import { projectIdOfCompressed } from '../compressedPath';

/** projectId: 所属项目（undefined = 全局/不带项目标注）——供结构粗筛按归属圈定（G20）。 */
export type EpisodeBrief = { id: string; line: string; title: string; projectId?: string };

function formatBrief(e: EpisodeFile): string {
  const date = e.updated ? e.updated.slice(0, 10) : '';
  const dims = [e.type, date].filter(Boolean).join('·');
  const tail = e.description ? `${e.title} - ${e.description}` : e.title;
  return `${e.compressedPath} [${dims}] ${tail}`;
}

export async function buildEpisodeBriefs(ownerId: string): Promise<EpisodeBrief[]> {
  const eps = await scanAllActiveEpisodes(ownerId);
  // 与 index 同口径：按 updated 倒序（最近的在前），id 稳定，利于挑选器与测试确定性
  eps.sort((a, b) => b.updated.localeCompare(a.updated));
  return eps.map((e) => ({
    id: e.compressedPath,
    line: formatBrief(e),
    title: e.title,
    projectId: projectIdOfCompressed(e.compressedPath),
  }));
}
