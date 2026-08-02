import { create } from 'zustand';
import type { Agent } from '@shared/types';
import type { AgentsStateEvent } from '@shared/protocol';
import { wsClient } from '@/lib/ws';

type AgentStoreState = {
  agents: Agent[];
  activeAgentId: string | null;
  syncFromServer: (agents: Agent[], activeId: string | null) => void;
  refresh: () => Promise<void>;
  update: (agentId: string, patch: Partial<Agent>) => Promise<void>;
};

export const useAgentStore = create<AgentStoreState>((set) => ({
  agents: [],
  activeAgentId: null,
  syncFromServer: (agents, activeId) => set({ agents, activeAgentId: activeId }),
  async refresh() {
    try {
      const res = await wsClient.request<AgentsStateEvent>({ type: 'agents.list' });
      if (res.type === 'agents.state') {
        set({ agents: res.agents, activeAgentId: res.activeId });
      }
    } catch {
      // ignore
    }
  },
  async update(agentId, patch) {
    try {
      const res = await wsClient.request<AgentsStateEvent>({
        type: 'agents.update',
        agentId,
        patch,
      });
      if (res.type === 'agents.state') {
        set({ agents: res.agents, activeAgentId: res.activeId });
      }
    } catch {
      // ignore
    }
  },
}));
