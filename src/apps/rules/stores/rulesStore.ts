// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import type {
  FrameDefDescriptor,
  BridgeDescriptor,
  TransformerDescriptor,
  GeneratorDescriptor,
} from "../../../api/framelinkRules";
import {
  framelinkProbe,
  type ProbeResult,
  framelinkFrameDefList,
  framelinkFrameDefAdd,
  framelinkFrameDefRemove,
  framelinkBridgeList,
  framelinkBridgeAdd,
  framelinkBridgeRemove,
  framelinkBridgeEnable,
  framelinkXformList,
  framelinkXformAdd,
  framelinkXformRemove,
  framelinkXformEnable,
  framelinkGenList,
  framelinkGenAdd,
  framelinkGenRemove,
  framelinkGenEnable,
  framelinkPersistSave,
  framelinkPersistLoad,
  framelinkPersistClear,
  framelinkUserSignalAdd,
  framelinkUserSignalRemove,
} from "../../../api/framelinkRules";

// ============================================================================
// Types
// ============================================================================

export type RulesTab =
  | "overview"
  | "frame-defs"
  | "bridges"
  | "transformers"
  | "generators"
  | "indicators"
  | "user-signals";

export type RulePersistenceState = "existing" | "temporary" | "persisted";

export interface StatusBarEntry {
  text: string;
  type: "success" | "error" | "info";
  timestamp: number;
}

interface DeviceState {
  /** Unique device identity from capabilities (e.g. "WiredFlexLink-9D04") */
  deviceId: string;
  /** Display label derived from the profile name */
  label: string;
  /** Network address used for the initial probe */
  host: string;
  port: number;
  connecting: boolean;
  connected: boolean;
  error: string | null;
  interfaces: ProbeResult["interfaces"];
}

interface LoadingState {
  frameDefs: boolean;
  bridges: boolean;
  transformers: boolean;
  generators: boolean;
  userSignals: boolean;
}

interface RulesState {
  device: DeviceState | null;
  activeTab: RulesTab;
  frameDefs: FrameDefDescriptor[];
  bridges: BridgeDescriptor[];
  transformers: TransformerDescriptor[];
  generators: GeneratorDescriptor[];
  loading: LoadingState;
  temporaryRules: Set<string>;
  selectedItemId: string | null;
  error: string | null;
  statusBar: StatusBarEntry | null;
}

interface RulesActions {
  connectDevice: (host: string, port: number, label: string) => Promise<void>;
  disconnectDevice: () => void;
  setActiveTab: (tab: RulesTab) => void;
  refreshTab: (tab?: RulesTab) => Promise<void>;
  addFrameDef: (frameDef: Record<string, unknown>) => Promise<void>;
  removeFrameDef: (frameDefId: number) => Promise<void>;
  addBridge: (bridge: Record<string, unknown>) => Promise<void>;
  removeBridge: (bridgeId: number) => Promise<void>;
  enableBridge: (bridgeId: number, enabled: boolean) => Promise<void>;
  addTransformer: (transformer: Record<string, unknown>) => Promise<void>;
  removeTransformer: (transformerId: number) => Promise<void>;
  enableTransformer: (transformerId: number, enabled: boolean) => Promise<void>;
  addGenerator: (generator: Record<string, unknown>) => Promise<void>;
  removeGenerator: (generatorId: number) => Promise<void>;
  enableGenerator: (generatorId: number, enabled: boolean) => Promise<void>;
  persistSave: () => Promise<void>;
  persistLoad: () => Promise<void>;
  persistClear: () => Promise<void>;
  addUserSignal: (signalId: number) => Promise<void>;
  removeUserSignal: (signalId: number) => Promise<void>;
  selectItem: (id: string | null) => void;
  clearError: () => void;
  setStatusBar: (entry: StatusBarEntry | null) => void;
  reset: () => void;
}

const initialState: RulesState = {
  device: null,
  activeTab: "frame-defs",
  frameDefs: [],
  bridges: [],
  transformers: [],
  generators: [],
  loading: {
    frameDefs: false,
    bridges: false,
    transformers: false,
    generators: false,
    userSignals: false,
  },
  temporaryRules: new Set(),
  selectedItemId: null,
  error: null,
  statusBar: null,
};

// ============================================================================
// Helpers
// ============================================================================

function statusSuccess(text: string): StatusBarEntry {
  return { text, type: "success", timestamp: Date.now() };
}

function statusError(text: string): StatusBarEntry {
  return { text, type: "error", timestamp: Date.now() };
}

function statusInfo(text: string): StatusBarEntry {
  return { text, type: "info", timestamp: Date.now() };
}

// ============================================================================
// Store
// ============================================================================

export const useRulesStore = create<RulesState & RulesActions>()((set, get) => {
  /** Get the device_id of the connected device, or throw. */
  function deviceId(): string {
    const d = get().device;
    if (!d || !d.connected) throw new Error("Not connected to device");
    return d.deviceId;
  }

  async function loadTab(tab: RulesTab) {
    const did = deviceId();
    switch (tab) {
      case "frame-defs": {
        set((s) => ({ loading: { ...s.loading, frameDefs: true } }));
        try {
          const frameDefs = await framelinkFrameDefList(did);
          set((s) => ({ frameDefs, loading: { ...s.loading, frameDefs: false } }));
        } catch (e) {
          set((s) => ({ loading: { ...s.loading, frameDefs: false }, error: `Failed to load frame defs: ${e}` }));
        }
        break;
      }
      case "bridges": {
        set((s) => ({ loading: { ...s.loading, bridges: true } }));
        try {
          const bridges = await framelinkBridgeList(did);
          set((s) => ({ bridges, loading: { ...s.loading, bridges: false } }));
        } catch (e) {
          set((s) => ({ loading: { ...s.loading, bridges: false }, error: `Failed to load bridges: ${e}` }));
        }
        break;
      }
      case "transformers": {
        set((s) => ({ loading: { ...s.loading, transformers: true } }));
        try {
          const transformers = await framelinkXformList(did);
          set((s) => ({ transformers, loading: { ...s.loading, transformers: false } }));
        } catch (e) {
          set((s) => ({ loading: { ...s.loading, transformers: false }, error: `Failed to load transformers: ${e}` }));
        }
        break;
      }
      case "generators": {
        set((s) => ({ loading: { ...s.loading, generators: true } }));
        try {
          const generators = await framelinkGenList(did);
          set((s) => ({ generators, loading: { ...s.loading, generators: false } }));
        } catch (e) {
          set((s) => ({ loading: { ...s.loading, generators: false }, error: `Failed to load generators: ${e}` }));
        }
        break;
      }
    }
  }

  return {
    ...initialState,

    connectDevice: async (host, port, label) => {
      // Guard against double-connect (React strict mode, effect re-fires)
      const current = get().device;
      if (current?.connecting || current?.connected) return;

      set({
        device: { deviceId: "", label, host, port, connecting: true, connected: false, error: null, interfaces: [] },
        error: null,
        statusBar: statusInfo(`Connecting to ${label}...`),
      });
      try {
        // Probe device via WS command — the backend connection manager handles the TCP connection
        const probe = await framelinkProbe(host, port);
        const resolvedId = probe.device_id ?? `${host}:${port}`;
        // Load initial data using the device_id (now resolvable in the pool)
        const frameDefs = await framelinkFrameDefList(resolvedId);
        set({
          device: {
            deviceId: resolvedId,
            label: label || resolvedId,
            host,
            port,
            connecting: false,
            connected: true,
            error: null,
            interfaces: probe.interfaces,
          },
          frameDefs,
          temporaryRules: new Set(),
          statusBar: statusSuccess(`Connected to ${label || resolvedId}`),
        });
      } catch (e) {
        set({
          device: { deviceId: "", label, host, port, connecting: false, connected: false, error: String(e), interfaces: [] },
          error: `Connection failed: ${e}`,
          statusBar: statusError(`Connection failed: ${e}`),
        });
      }
    },

    disconnectDevice: () => set({ ...initialState, temporaryRules: new Set() }),

    setActiveTab: (tab) => {
      const prev = get().activeTab;
      set({ activeTab: tab });
      if (tab !== prev && get().device?.connected) {
        loadTab(tab);
      }
    },

    refreshTab: async (tab) => {
      const target = tab ?? get().activeTab;
      if (get().device?.connected) await loadTab(target);
    },

    addFrameDef: async (frameDef) => {
      await framelinkFrameDefAdd(deviceId(), frameDef);
      set((s) => {
        const temp = new Set(s.temporaryRules);
        temp.add(`framedef:${frameDef.frame_def_id}`);
        return { temporaryRules: temp, statusBar: statusSuccess("Frame definition added") };
      });
      await loadTab("frame-defs");
    },

    removeFrameDef: async (frameDefId) => {
      await framelinkFrameDefRemove(deviceId(), frameDefId);
      set((s) => {
        const temp = new Set(s.temporaryRules);
        temp.delete(`framedef:${frameDefId}`);
        return { temporaryRules: temp, statusBar: statusSuccess("Frame definition removed") };
      });
      await loadTab("frame-defs");
    },

    addBridge: async (bridge) => {
      await framelinkBridgeAdd(deviceId(), bridge);
      set((s) => {
        const temp = new Set(s.temporaryRules);
        temp.add(`bridge:${bridge.bridge_id}`);
        return { temporaryRules: temp, statusBar: statusSuccess("Bridge added") };
      });
      await loadTab("bridges");
    },

    removeBridge: async (bridgeId) => {
      await framelinkBridgeRemove(deviceId(), bridgeId);
      set((s) => {
        const temp = new Set(s.temporaryRules);
        temp.delete(`bridge:${bridgeId}`);
        return { temporaryRules: temp, statusBar: statusSuccess("Bridge removed") };
      });
      await loadTab("bridges");
    },

    enableBridge: async (bridgeId, enabled) => {
      await framelinkBridgeEnable(deviceId(), bridgeId, enabled);
      set({ statusBar: statusSuccess(`Bridge ${enabled ? "enabled" : "disabled"}`) });
      await loadTab("bridges");
    },

    addTransformer: async (transformer) => {
      await framelinkXformAdd(deviceId(), transformer);
      set((s) => {
        const temp = new Set(s.temporaryRules);
        temp.add(`xform:${transformer.transformer_id}`);
        return { temporaryRules: temp, statusBar: statusSuccess("Transformer added") };
      });
      await loadTab("transformers");
    },

    removeTransformer: async (transformerId) => {
      await framelinkXformRemove(deviceId(), transformerId);
      set((s) => {
        const temp = new Set(s.temporaryRules);
        temp.delete(`xform:${transformerId}`);
        return { temporaryRules: temp, statusBar: statusSuccess("Transformer removed") };
      });
      await loadTab("transformers");
    },

    enableTransformer: async (transformerId, enabled) => {
      await framelinkXformEnable(deviceId(), transformerId, enabled);
      set({ statusBar: statusSuccess(`Transformer ${enabled ? "enabled" : "disabled"}`) });
      await loadTab("transformers");
    },

    addGenerator: async (generator) => {
      await framelinkGenAdd(deviceId(), generator);
      set((s) => {
        const temp = new Set(s.temporaryRules);
        temp.add(`gen:${generator.generator_id}`);
        return { temporaryRules: temp, statusBar: statusSuccess("Generator added") };
      });
      await loadTab("generators");
    },

    removeGenerator: async (generatorId) => {
      await framelinkGenRemove(deviceId(), generatorId);
      set((s) => {
        const temp = new Set(s.temporaryRules);
        temp.delete(`gen:${generatorId}`);
        return { temporaryRules: temp, statusBar: statusSuccess("Generator removed") };
      });
      await loadTab("generators");
    },

    enableGenerator: async (generatorId, enabled) => {
      await framelinkGenEnable(deviceId(), generatorId, enabled);
      set({ statusBar: statusSuccess(`Generator ${enabled ? "enabled" : "disabled"}`) });
      await loadTab("generators");
    },

    persistSave: async () => {
      set({ statusBar: statusInfo("Saving configuration to NVS...") });
      try {
        await framelinkPersistSave(deviceId());
        set({ temporaryRules: new Set(), statusBar: statusSuccess("Configuration saved to NVS") });
      } catch (e) {
        set({ statusBar: statusError(`Persist failed: ${e}`) });
        throw e;
      }
    },

    persistLoad: async () => {
      set({ statusBar: statusInfo("Loading persisted configuration...") });
      try {
        await framelinkPersistLoad(deviceId());
        set({ temporaryRules: new Set(), statusBar: statusSuccess("Persisted configuration loaded") });
        await loadTab(get().activeTab);
      } catch (e) {
        set({ statusBar: statusError(`Load failed: ${e}`) });
        throw e;
      }
    },

    persistClear: async () => {
      set({ statusBar: statusInfo("Clearing persisted rules...") });
      try {
        await framelinkPersistClear(deviceId());
        set({ statusBar: statusSuccess("Persisted rules cleared") });
        await loadTab(get().activeTab);
      } catch (e) {
        set({ statusBar: statusError(`Clear failed: ${e}`) });
        throw e;
      }
    },

    addUserSignal: async (signalId) => {
      await framelinkUserSignalAdd(deviceId(), signalId);
      set((s) => {
        const temp = new Set(s.temporaryRules);
        temp.add(`usersig:${signalId}`);
        return { temporaryRules: temp, statusBar: statusSuccess("User signal added") };
      });
    },

    removeUserSignal: async (signalId) => {
      await framelinkUserSignalRemove(deviceId(), signalId);
      set((s) => {
        const temp = new Set(s.temporaryRules);
        temp.delete(`usersig:${signalId}`);
        return { temporaryRules: temp, statusBar: statusSuccess("User signal removed") };
      });
    },

    selectItem: (id) => set({ selectedItemId: id }),
    clearError: () => set({ error: null }),
    setStatusBar: (entry) => set({ statusBar: entry }),
    reset: () => set({ ...initialState, temporaryRules: new Set() }),
  };
});
