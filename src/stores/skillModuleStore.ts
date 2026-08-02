/**
 * Skill 模块（v1）前端状态——已装 plugin 和已装 skill。
 *
 * 数据来源：
 * - 启动时拉一次 plugin.list + skill.list 填满
 * - 主进程 plugins.state / skills.state broadcast 时整体覆盖
 *
 * 跟 mcpRuntimeStore 同款简易形态——不区分 byId / list，直接存数组（数量 < 50 时 O(N)
 * 查找可接受；超 100 个时再加索引）。
 */
import { create } from 'zustand';
import type { PluginRecord, PluginUpdateInfo, SkillRecord } from '@shared/types';

type Store = {
  plugins: PluginRecord[];
  skills: SkillRecord[];
  pluginsLoaded: boolean;
  skillsLoaded: boolean;
  /** plugin 升级信息（pluginId → latestCommit / errorMessage）；拓展页 mount 时拉一次 */
  updates: Record<string, PluginUpdateInfo>;
  setPlugins: (plugins: PluginRecord[]) => void;
  setSkills: (skills: SkillRecord[]) => void;
  setUpdates: (updates: PluginUpdateInfo[]) => void;
};

export const useSkillModuleStore = create<Store>((set) => ({
  plugins: [],
  skills: [],
  pluginsLoaded: false,
  skillsLoaded: false,
  updates: {},
  setPlugins: (plugins) => set({ plugins, pluginsLoaded: true }),
  setSkills: (skills) => set({ skills, skillsLoaded: true }),
  setUpdates: (updates) =>
    set({ updates: Object.fromEntries(updates.map((u) => [u.pluginId, u])) }),
}));
