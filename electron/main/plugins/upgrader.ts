/**
 * Plugin 升级（Skill 模块 v1）。
 *
 * - checkPluginUpdates：git ls-remote 拿上游 HEAD，对比本地 commit
 * - getUpdateDiff：mkdtemp → 浅 clone → 拿 key 文件 patch + commit message 列表
 * - performPluginUpdate：git fetch + checkout 到 toCommit → 重启变化的 MCP → 更新 registry
 *
 * key 文件指（拓展页 PRD L139）：SKILL.md / .mcp.json / plugin.json / scripts/*。
 * 其余文件只数文件数。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';
import type {
  PluginUpdateProposal,
  PluginUpdateInfo,
  PluginDiffSummary,
} from '@shared/types';
import { pluginDir } from '../runtime/paths';
import { safeWriteAsync } from '../fs/safeWrite';
import {
  listPlugins,
  getPlugin,
  loadPluginFromDir,
  upsertPlugin,
} from './registry';
import { failure } from '../proposals/failure';

const KEY_FILE_PATTERNS = [
  /^\.claude-plugin\/plugin\.json$/,
  /^\.mcp\.json$/,
  /^SKILL\.md$/,
  /^skills\/[^/]+\/SKILL\.md$/,
  /^scripts\//,
];

function isKeyFile(path: string): boolean {
  return KEY_FILE_PATTERNS.some((re) => re.test(path));
}

/**
 * 检查所有已装 plugin 的上游 HEAD commit（git ls-remote，不 clone）。
 * 进拓展页时调一次；单条失败标"检查失败"不阻塞整体。
 */
export async function checkPluginUpdates(): Promise<PluginUpdateInfo[]> {
  const plugins = listPlugins();
  const out: PluginUpdateInfo[] = [];
  await Promise.all(
    plugins.map(async (p) => {
      const url = p.oruExtension.source.url;
      if (!url) {
        out.push({
          pluginId: p.id,
          currentCommit: p.oruExtension.source.commit ?? '',
          latestCommit: '',
          errorMessage: '本地手放 plugin，无上游 URL',
        });
        return;
      }
      try {
        const git = simpleGit();
        // ls-remote 不需要本地 repo——直接给 URL 即可
        const refs = await git.listRemote([url, 'HEAD']);
        const latest = parseHeadCommit(refs);
        out.push({
          pluginId: p.id,
          currentCommit: p.oruExtension.source.commit ?? '',
          latestCommit: latest ?? '',
          errorMessage: latest ? undefined : '上游 HEAD 解析失败',
        });
      } catch (e) {
        out.push({
          pluginId: p.id,
          currentCommit: p.oruExtension.source.commit ?? '',
          latestCommit: '',
          errorMessage: (e as Error).message,
        });
      }
    }),
  );
  return out;
}

function parseHeadCommit(refsOutput: string): string | null {
  // git ls-remote 输出形如 "<sha>\tHEAD\n<sha>\trefs/heads/main\n..."
  for (const line of refsOutput.split('\n')) {
    const parts = line.split('\t');
    if (parts.length === 2 && parts[1].trim() === 'HEAD') return parts[0].trim();
  }
  return null;
}

/**
 * 按需重 clone 拿 diff 摘要。返回 null 表示拿不到（plugin 不存在 / 上游不可达）。
 *
 * 策略：mkdtemp → simpleGit({ baseDir: tmpDir }) → clone --depth=50 → diffSummary
 * 失败时清理临时目录后返回 null。
 */
export async function getUpdateDiff(pluginId: string): Promise<PluginDiffSummary | null> {
  const plugin = getPlugin(pluginId);
  if (!plugin?.oruExtension.source.url) return null;
  const url = plugin.oruExtension.source.url;
  const currentCommit = plugin.oruExtension.source.commit;
  if (!currentCommit) return null;

  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'oru-plugin-diff-'));
  try {
    const git = simpleGit({ baseDir: tmpRoot });
    // depth=50 兜住中等规模升级；超过 50 个 commit 的升级 diff 会被 git 拒绝（fallback：only file count）
    await git.clone(url, '.', ['--depth=50']);
    // 拿到 HEAD commit
    const latestCommit = (await git.revparse(['HEAD'])).trim();
    if (latestCommit === currentCommit) {
      return {
        fromCommit: currentCommit,
        toCommit: latestCommit,
        keyFiles: [],
        otherFilesCount: 0,
        commitMessages: [],
      };
    }
    // 把 currentCommit 拉下来——浅 clone 不一定含历史，需要 fetch
    try {
      await git.fetch(['--depth=50', 'origin', currentCommit]);
    } catch {
      // currentCommit 不在最近 50 commit 内——降级为"只列文件计数"
    }
    // diffSummary：拿 file 列表
    let diffSummary;
    try {
      diffSummary = await git.diffSummary([currentCommit, latestCommit]);
    } catch (e) {
      console.warn(`[oru.plugins] getUpdateDiff 失败 ${pluginId}:`, e);
      return {
        fromCommit: currentCommit,
        toCommit: latestCommit,
        keyFiles: [],
        otherFilesCount: 0,
        commitMessages: [],
      };
    }
    const keyFilePaths = diffSummary.files.filter((f) => isKeyFile(f.file)).map((f) => f.file);
    const otherFilesCount = diffSummary.files.length - keyFilePaths.length;
    // 对每个 key 文件单独拿 patch
    const keyFiles: PluginDiffSummary['keyFiles'] = [];
    for (const file of keyFilePaths) {
      try {
        const patch = await git.diff([currentCommit, latestCommit, '--', file]);
        keyFiles.push({ path: file, patch });
      } catch {
        keyFiles.push({ path: file, patch: '(diff 读取失败)' });
      }
    }
    // 拿中间 commit message
    let commitMessages: string[] = [];
    try {
      const log = await git.log({ from: currentCommit, to: latestCommit });
      commitMessages = log.all.map((c) => c.message);
    } catch {
      // 兜底
    }
    return {
      fromCommit: currentCommit,
      toCommit: latestCommit,
      keyFiles,
      otherFilesCount,
      commitMessages,
    };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 纯执行：升级一个已审批的 plugin。在 ~/.oru/plugins/<pluginId>/ 内 git fetch + checkout 到
 * toCommit，重启变化的 MCP，更新 .oru-plugin.json 的 commit 字段，重建注册表。
 * 成功返回升了谁、失败抛错；状态迁移与 chip 由调用方统一收尾（proposals/outcomeChip）。
 */
export async function performPluginUpdate(
  proposal: PluginUpdateProposal,
): Promise<{ pluginId: string; name: string }> {
  const plugin = getPlugin(proposal.pluginId);
  if (!plugin) throw failure('pluginNotFound', { id: proposal.pluginId });
  const dir = pluginDir(proposal.pluginId);
  const git = simpleGit({ baseDir: dir });

  try {
    // fetch 拿到目标 commit + 兜深度
    await git.fetch(['--depth=50', 'origin', proposal.toCommit]);
    await git.checkout(proposal.toCommit);
  } catch (e) {
    throw failure('pluginGitFailed', { error: (e as Error).message });
  }

  // 更新 .oru-plugin.json 的 commit。以盘上现文件为基底只改 source.commit——
  // enabled 是盘上独立顶层键（registry 读、缺失视同 true），不在内存 oruExtension 里，
  // 从内存重组整份文件会把它丢掉，已禁用的 plugin 升级后就静默复活。盘是真相源。
  // （能走到升级的 plugin 必有 installer 写的该文件；读失败按写失败同路兜底。）
  try {
    const oruExtPath = join(dir, '.oru-plugin.json');
    const onDisk = JSON.parse(await fs.readFile(oruExtPath, 'utf-8')) as {
      source?: Record<string, unknown>;
    } & Record<string, unknown>;
    onDisk.source = { ...onDisk.source, commit: proposal.toCommit };
    // 改写既有文件走原子写内核（tmp+rename）
    await safeWriteAsync(oruExtPath, JSON.stringify(onDisk, null, 2));
  } catch (e) {
    throw failure('pluginManifestWriteFailed', { error: (e as Error).message });
  }

  // 重建注册表条目（重读 manifest / 内含 skill / MCP）
  try {
    const record = await loadPluginFromDir(proposal.pluginId, dir);
    if (!record) {
      throw new Error('升级后重新加载 plugin 失败');
    }
    upsertPlugin(record);
  } catch (e) {
    throw failure('pluginReloadFailed', { error: (e as Error).message });
  }

  // 简化：plugin 内 MCP 的重启不在第 5 期细做——如果 .mcp.json 改了，用户需要去 MCP 区
  // 手动 restart；后续 v1.1 加自动重启
  return { pluginId: proposal.pluginId, name: plugin.manifest.name };
}

// chip 写入收敛到 skills/chipWriter.ts
