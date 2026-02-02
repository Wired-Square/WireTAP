// src/apps/session-manager/stores/sessionManagerStore.ts

import { create } from "zustand";

export type SelectedNodeType = "source" | "session" | "listener" | null;

export interface SelectedNode {
  id: string;
  type: SelectedNodeType;
}

interface SessionManagerState {
  // UI state
  selectedNode: SelectedNode | null;
  isRefreshing: boolean;
  autoRefresh: boolean;
  refreshIntervalMs: number;

  // Actions
  setSelectedNode: (node: SelectedNode | null) => void;
  setIsRefreshing: (isRefreshing: boolean) => void;
  setAutoRefresh: (autoRefresh: boolean) => void;
}

export const useSessionManagerStore = create<SessionManagerState>((set) => ({
  // Initial state
  selectedNode: null,
  isRefreshing: false,
  autoRefresh: true,
  refreshIntervalMs: 2000,

  // Actions
  setSelectedNode: (node) => set({ selectedNode: node }),
  setIsRefreshing: (isRefreshing) => set({ isRefreshing }),
  setAutoRefresh: (autoRefresh) => set({ autoRefresh }),
}));
