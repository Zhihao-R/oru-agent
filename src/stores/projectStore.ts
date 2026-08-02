import { create } from 'zustand';
import type { Project } from '@shared/types';
import { wsClient } from '@/lib/ws';

type ProjectStoreState = {
  projects: Project[];
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;
  syncFromServer: (projects: Project[], activeId: string | null) => void;
  refresh: () => Promise<void>;
  addProject: (path: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  switchProject: (id: string) => Promise<void>;
};

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  loading: false,
  error: null,
  syncFromServer: (projects, activeId) => {
    set({ projects, activeProjectId: activeId });
  },
  async refresh() {
    set({ loading: true, error: null });
    try {
      const res = await wsClient.request({ type: 'projects.list' });
      if (res.type === 'projects.state') {
        set({ projects: res.projects, activeProjectId: res.activeId });
      }
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },
  async addProject(path) {
    // 错误向上抛给调用方（如 AddProjectDialog）展示，不写到全局 store.error
    const res = await wsClient.request({ type: 'projects.add', path });
    if (res.type === 'projects.state') {
      set({ projects: res.projects, activeProjectId: res.activeId });
    }
  },
  async removeProject(id) {
    set({ error: null });
    try {
      const res = await wsClient.request({ type: 'projects.remove', id });
      if (res.type === 'projects.state') {
        set({ projects: res.projects, activeProjectId: res.activeId });
      }
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },
  async switchProject(id) {
    if (get().activeProjectId === id) return;
    set({ error: null });
    try {
      const res = await wsClient.request({ type: 'projects.switch', id });
      if (res.type === 'projects.state') {
        set({ projects: res.projects, activeProjectId: res.activeId });
      }
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },
}));
