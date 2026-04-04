// src/apps/test-pattern/stores/testPatternStore.ts

import { create } from "zustand";
import type { IOTestState, TestMode, TestRole } from "../../../api/testPattern";

interface TestPatternState {
  // Config
  sessionId: string | null;
  mode: TestMode;
  role: TestRole;
  durationSec: number;
  rateHz: number;
  bus: number;
  useFd: boolean;
  useExtended: boolean;

  // Running state
  testId: string | null;
  isRunning: boolean;
  testState: IOTestState | null;
  /** Expected TX count, set at test start from config (rate × duration). Used for gauge scale. */
  expectedTxCount: number;

  // Actions
  setSessionId: (id: string | null) => void;
  setMode: (mode: TestMode) => void;
  setRole: (role: TestRole) => void;
  setDurationSec: (sec: number) => void;
  setRateHz: (hz: number) => void;
  setBus: (bus: number) => void;
  setUseFd: (fd: boolean) => void;
  setUseExtended: (ext: boolean) => void;
  setTestId: (id: string | null) => void;
  setIsRunning: (running: boolean) => void;
  setExpectedTxCount: (count: number) => void;
  updateTestState: (state: IOTestState) => void;
  clearTestState: () => void;
}

export const useTestPatternStore = create<TestPatternState>((set) => ({
  sessionId: null,
  mode: "echo",
  role: "initiator",
  durationSec: 10,
  rateHz: 10,
  bus: 0,
  useFd: false,
  useExtended: false,

  testId: null,
  isRunning: false,
  testState: null,
  expectedTxCount: 0,

  setSessionId: (id) => set({ sessionId: id }),
  setMode: (mode) => set({ mode }),
  setRole: (role) => set({ role }),
  setDurationSec: (sec) => set({ durationSec: sec }),
  setRateHz: (hz) => set({ rateHz: hz }),
  setBus: (bus) => set({ bus }),
  setUseFd: (fd) => set({ useFd: fd }),
  setUseExtended: (ext) => set({ useExtended: ext }),
  setTestId: (id) => set({ testId: id }),
  setIsRunning: (running) => set({ isRunning: running }),
  setExpectedTxCount: (count) => set({ expectedTxCount: count }),
  updateTestState: (state) => {
    const isTerminal = state.status === "completed" || state.status === "stopped" || state.status === "failed";
    set({ testState: state, isRunning: !isTerminal });
  },
  clearTestState: () => set({ testState: null, testId: null, isRunning: false, expectedTxCount: 0 }),
}));
