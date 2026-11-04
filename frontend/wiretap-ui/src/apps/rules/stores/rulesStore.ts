// Copyright 2026 Wired Square Pty Ltd

import i18n from "i18next";
import { create } from "@wired-square/store/react";
import type {
  FrameDefDescriptor,
  BridgeDescriptor,
  TransformerDescriptor,
  GeneratorDescriptor,
  DiscoveredLed,
  SelectableSignal,
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
  framelinkIndicatorsList,
  framelinkPersistSave,
  framelinkPersistLoad,
  framelinkPersistClear,
  framelinkUserSignalAdd,
  framelinkUserSignalRemove,
  framelinkSignalsSelectable,
  framelinkLabelSet,
  type LabelEntityType,
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
  | "user-signals"
  | "log";

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
  indicators: boolean;
  userSignals: boolean;
  selectableSignals: boolean;
}

interface RulesState {
  device: DeviceState | null;
  activeTab: RulesTab;
  frameDefs: FrameDefDescriptor[];
  bridges: BridgeDescriptor[];
  transformers: TransformerDescriptor[];
  generators: GeneratorDescriptor[];
  indicators: DiscoveredLed[];
  selectableSignals: SelectableSignal[];
  loading: LoadingState;
  temporaryRules: Set<string>;
  selectedItemId: string | null;
  error: string | null;
  statusBar: StatusBarEntry | null;
  /** Bounded history of status events (max 200), oldest first. */
  statusLog: StatusBarEntry[];
}

const STATUS_LOG_MAX = 200;

interface RulesActions {
  connectDevice: (host: string, port: number, label: string) => Promise<void>;
  disconnectDevice: () => void;
  setActiveTab: (tab: RulesTab) => void;
  refreshTab: (tab?: RulesTab) => Promise<void>;
  addFrameDef: (frameDef: Record<string, unknown>) => Promise<boolean>;
  removeFrameDef: (frameDefId: number) => Promise<boolean>;
  addBridge: (bridge: Record<string, unknown>) => Promise<boolean>;
  removeBridge: (bridgeId: number) => Promise<boolean>;
  enableBridge: (bridgeId: number, enabled: boolean) => Promise<boolean>;
  addTransformer: (transformer: Record<string, unknown>) => Promise<boolean>;
  removeTransformer: (transformerId: number) => Promise<boolean>;
  enableTransformer: (transformerId: number, enabled: boolean) => Promise<boolean>;
  addGenerator: (generator: Record<string, unknown>) => Promise<boolean>;
  removeGenerator: (generatorId: number) => Promise<boolean>;
  enableGenerator: (generatorId: number, enabled: boolean) => Promise<boolean>;
  persistSave: () => Promise<boolean>;
  persistLoad: () => Promise<boolean>;
  persistClear: () => Promise<boolean>;
  refreshIndicators: () => Promise<void>;
  loadSelectableSignals: () => Promise<void>;
  addUserSignal: (signalId: number, metadata?: { name: string; group: string; format: string; unit: string; enum_values?: Record<string, string> }) => Promise<boolean>;
  removeUserSignal: (signalId: number) => Promise<boolean>;
  setLabel: (entityType: LabelEntityType, id: number, name: string | null, description: string | null) => Promise<boolean>;
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
  indicators: [],
  selectableSignals: [],
  loading: {
    frameDefs: false,
    bridges: false,
    transformers: false,
    generators: false,
    indicators: false,
    userSignals: false,
    selectableSignals: false,
  },
  temporaryRules: new Set(),
  selectedItemId: null,
  error: null,
  statusBar: null,
  statusLog: [],
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

function liveRules(s: RulesState): Set<string> {
  return new Set([
    ...s.frameDefs.map((f) => `framedef:${f.frame_def_id}`),
    ...s.bridges.map((b) => `bridge:${b.bridge_id}`),
    ...s.transformers.map((t) => `xform:${t.transformer_id}`),
    ...s.generators.map((g) => `gen:${g.generator_id}`),
    ...s.selectableSignals.filter((sig) => sig.tier === "user").map((sig) => `usersig:${sig.signal_id}`),
  ]);
}

/** Format a numeric ID as 0xNNNN for log readability. */
function hexId(id: number): string {
  return `0x${id.toString(16).toUpperCase().padStart(4, "0")}`;
}

const say = (key: string, options?: Record<string, unknown>) => i18n.t(`rules:store.${key}`, options);

// ============================================================================
// Store
// ============================================================================

export const useRulesStore = create<RulesState & RulesActions>()((set, get) => {
  /** Get the device_id of the connected device, or throw. */
  function deviceId(): string {
    const d = get().device;
    if (!d || !d.connected) throw new Error(say("notConnected"));
    return d.deviceId;
  }

  async function reported(what: string, op: () => Promise<void>): Promise<boolean> {
    try {
      await op();
      return true;
    } catch (e) {
      const text = say("failed", { action: what, error: String(e) });
      set({ error: text, statusBar: statusError(text) });
      return false;
    }
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
          set((s) => ({ loading: { ...s.loading, frameDefs: false }, error: say("loadFailed.frameDefs", { error: String(e) }) }));
        }
        break;
      }
      case "bridges": {
        set((s) => ({ loading: { ...s.loading, bridges: true } }));
        try {
          const bridges = await framelinkBridgeList(did);
          set((s) => ({ bridges, loading: { ...s.loading, bridges: false } }));
        } catch (e) {
          set((s) => ({ loading: { ...s.loading, bridges: false }, error: say("loadFailed.bridges", { error: String(e) }) }));
        }
        break;
      }
      case "transformers": {
        set((s) => ({ loading: { ...s.loading, transformers: true } }));
        try {
          const transformers = await framelinkXformList(did);
          set((s) => ({ transformers, loading: { ...s.loading, transformers: false } }));
        } catch (e) {
          set((s) => ({ loading: { ...s.loading, transformers: false }, error: say("loadFailed.transformers", { error: String(e) }) }));
        }
        break;
      }
      case "generators": {
        set((s) => ({ loading: { ...s.loading, generators: true } }));
        try {
          const generators = await framelinkGenList(did);
          set((s) => ({ generators, loading: { ...s.loading, generators: false } }));
        } catch (e) {
          set((s) => ({ loading: { ...s.loading, generators: false }, error: say("loadFailed.generators", { error: String(e) }) }));
        }
        break;
      }
      case "indicators": {
        set((s) => ({ loading: { ...s.loading, indicators: true } }));
        try {
          const indicators = await framelinkIndicatorsList(did);
          set((s) => ({ indicators, loading: { ...s.loading, indicators: false } }));
        } catch (e) {
          set((s) => ({ loading: { ...s.loading, indicators: false }, error: say("loadFailed.indicators", { error: String(e) }) }));
        }
        break;
      }
    }
  }

  /** Load all rule types from the device. Called once on connect. */
  async function loadAllTabs() {
    // Run sequentially — single serialised connection, concurrent requests would just queue
    const tabs: RulesTab[] = ["frame-defs", "bridges", "transformers", "generators", "indicators"];
    for (const tab of tabs) {
      await loadTab(tab);
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
        statusBar: statusInfo(say("connecting", { label })),
      });
      try {
        // Probe device via WS command — the backend connection manager handles the TCP connection
        const probe = await framelinkProbe(host, port);
        const resolvedId = probe.device_id ?? `${host}:${port}`;
        // Mark connected first so loadAllTabs can use deviceId()
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
          temporaryRules: new Set(),
          statusBar: statusSuccess(say("connected", { label: label || resolvedId })),
        });
        // Load all rule data from the device
        await loadAllTabs();
        await get().loadSelectableSignals();
      } catch (e) {
        set({
          device: { deviceId: "", label, host, port, connecting: false, connected: false, error: String(e), interfaces: [] },
          error: say("connectionFailed", { error: String(e) }),
          statusBar: statusError(say("connectionFailed", { error: String(e) })),
        });
      }
    },

    disconnectDevice: () => set({ ...initialState, temporaryRules: new Set() }),

    setActiveTab: (tab) => {
      set({ activeTab: tab });
    },

    refreshTab: async (tab) => {
      const target = tab ?? get().activeTab;
      if (get().device?.connected) await loadTab(target);
    },

    addFrameDef: (frameDef) =>
      reported(say("adding.frameDef", { id: hexId(Number(frameDef.frame_def_id)) }), async () => {
        await framelinkFrameDefAdd(deviceId(), frameDef);
        const id = hexId(Number(frameDef.frame_def_id));
        set((s) => {
          const temp = new Set(s.temporaryRules);
          temp.add(`framedef:${frameDef.frame_def_id}`);
          return { temporaryRules: temp, statusBar: statusSuccess(say("added.frameDef", { id })) };
        });
        await loadTab("frame-defs");
        await get().loadSelectableSignals();
      }),

    removeFrameDef: (frameDefId) =>
      reported(say("removing.frameDef", { id: hexId(frameDefId) }), async () => {
        await framelinkFrameDefRemove(deviceId(), frameDefId);
        const id = hexId(frameDefId);
        set((s) => {
          const temp = new Set(s.temporaryRules);
          temp.delete(`framedef:${frameDefId}`);
          return { temporaryRules: temp, statusBar: statusSuccess(say("removed.frameDef", { id })) };
        });
        await loadTab("frame-defs");
        await get().loadSelectableSignals();
      }),

    addBridge: (bridge) =>
      reported(say("adding.bridge", { id: hexId(Number(bridge.bridge_id)) }), async () => {
        await framelinkBridgeAdd(deviceId(), bridge);
        const id = hexId(Number(bridge.bridge_id));
        set((s) => {
          const temp = new Set(s.temporaryRules);
          temp.add(`bridge:${bridge.bridge_id}`);
          return { temporaryRules: temp, statusBar: statusSuccess(say("added.bridge", { id })) };
        });
        await loadTab("bridges");
      }),

    removeBridge: (bridgeId) =>
      reported(say("removing.bridge", { id: hexId(bridgeId) }), async () => {
        await framelinkBridgeRemove(deviceId(), bridgeId);
        const id = hexId(bridgeId);
        set((s) => {
          const temp = new Set(s.temporaryRules);
          temp.delete(`bridge:${bridgeId}`);
          return { temporaryRules: temp, statusBar: statusSuccess(say("removed.bridge", { id })) };
        });
        await loadTab("bridges");
      }),

    enableBridge: (bridgeId, enabled) =>
      reported(say(`${enabled ? "enabling" : "disabling"}.bridge`, { id: hexId(bridgeId) }), async () => {
        await framelinkBridgeEnable(deviceId(), bridgeId, enabled);
        set({
          statusBar: statusSuccess(say(`${enabled ? "enabled" : "disabled"}.bridge`, { id: hexId(bridgeId) })),
        });
        await loadTab("bridges");
      }),

    addTransformer: (transformer) =>
      reported(say("adding.transformer", { id: hexId(Number(transformer.transformer_id)) }), async () => {
        await framelinkXformAdd(deviceId(), transformer);
        const id = hexId(Number(transformer.transformer_id));
        set((s) => {
          const temp = new Set(s.temporaryRules);
          temp.add(`xform:${transformer.transformer_id}`);
          return { temporaryRules: temp, statusBar: statusSuccess(say("added.transformer", { id })) };
        });
        await loadTab("transformers");
      }),

    removeTransformer: (transformerId) =>
      reported(say("removing.transformer", { id: hexId(transformerId) }), async () => {
        await framelinkXformRemove(deviceId(), transformerId);
        const id = hexId(transformerId);
        set((s) => {
          const temp = new Set(s.temporaryRules);
          temp.delete(`xform:${transformerId}`);
          return { temporaryRules: temp, statusBar: statusSuccess(say("removed.transformer", { id })) };
        });
        await loadTab("transformers");
      }),

    enableTransformer: (transformerId, enabled) =>
      reported(say(`${enabled ? "enabling" : "disabling"}.transformer`, { id: hexId(transformerId) }), async () => {
        await framelinkXformEnable(deviceId(), transformerId, enabled);
        set({
          statusBar: statusSuccess(say(`${enabled ? "enabled" : "disabled"}.transformer`, { id: hexId(transformerId) })),
        });
        await loadTab("transformers");
      }),

    addGenerator: (generator) =>
      reported(say("adding.generator", { id: hexId(Number(generator.generator_id)) }), async () => {
        await framelinkGenAdd(deviceId(), generator);
        const id = hexId(Number(generator.generator_id));
        set((s) => {
          const temp = new Set(s.temporaryRules);
          temp.add(`gen:${generator.generator_id}`);
          return { temporaryRules: temp, statusBar: statusSuccess(say("added.generator", { id })) };
        });
        await loadTab("generators");
      }),

    removeGenerator: (generatorId) =>
      reported(say("removing.generator", { id: hexId(generatorId) }), async () => {
        await framelinkGenRemove(deviceId(), generatorId);
        const id = hexId(generatorId);
        set((s) => {
          const temp = new Set(s.temporaryRules);
          temp.delete(`gen:${generatorId}`);
          return { temporaryRules: temp, statusBar: statusSuccess(say("removed.generator", { id })) };
        });
        await loadTab("generators");
      }),

    enableGenerator: (generatorId, enabled) =>
      reported(say(`${enabled ? "enabling" : "disabling"}.generator`, { id: hexId(generatorId) }), async () => {
        await framelinkGenEnable(deviceId(), generatorId, enabled);
        set({
          statusBar: statusSuccess(say(`${enabled ? "enabled" : "disabled"}.generator`, { id: hexId(generatorId) })),
        });
        await loadTab("generators");
      }),

    persistSave: async () => {
      set({ statusBar: statusInfo(say("persist.saving")) });
      return reported(say("persist.saveAction"), async () => {
        await framelinkPersistSave(deviceId());
        set({ temporaryRules: new Set(), statusBar: statusSuccess(say("persist.saved")) });
      });
    },

    persistLoad: async () => {
      set({ statusBar: statusInfo(say("persist.loading")) });
      return reported(say("persist.loadAction"), async () => {
        await framelinkPersistLoad(deviceId());
        set({ temporaryRules: new Set(), statusBar: statusSuccess(say("persist.loaded")) });
        await loadAllTabs();
        await get().loadSelectableSignals();
      });
    },

    persistClear: async () => {
      set({ statusBar: statusInfo(say("persist.clearing")) });
      return reported(say("persist.clearAction"), async () => {
        await framelinkPersistClear(deviceId());
        await loadAllTabs();
        await get().loadSelectableSignals();
        set((s) => ({ temporaryRules: liveRules(s), statusBar: statusSuccess(say("persist.cleared")) }));
      });
    },

    loadSelectableSignals: async () => {
      if (!get().device?.connected) return;
      set((s) => ({ loading: { ...s.loading, selectableSignals: true } }));
      try {
        const signals = await framelinkSignalsSelectable(deviceId());
        set((s) => ({ selectableSignals: signals, loading: { ...s.loading, selectableSignals: false } }));
      } catch (e) {
        set((s) => ({ loading: { ...s.loading, selectableSignals: false }, error: say("loadFailed.selectableSignals", { error: String(e) }) }));
      }
    },

    refreshIndicators: async () => {
      if (get().device?.connected) await loadTab("indicators");
    },

    addUserSignal: (signalId, metadata) =>
      reported(say("adding.userSignal", { id: hexId(signalId) }), async () => {
        await framelinkUserSignalAdd(deviceId(), signalId, metadata);
        const id = hexId(signalId);
        set((s) => {
          const temp = new Set(s.temporaryRules);
          temp.add(`usersig:${signalId}`);
          return {
            temporaryRules: temp,
            statusBar: statusSuccess(metadata?.name ? say("added.userSignalNamed", { id, name: metadata.name }) : say("added.userSignal", { id })),
          };
        });
        await get().loadSelectableSignals();
      }),

    removeUserSignal: (signalId) =>
      reported(say("removing.userSignal", { id: hexId(signalId) }), async () => {
        await framelinkUserSignalRemove(deviceId(), signalId);
        const id = hexId(signalId);
        set((s) => {
          const temp = new Set(s.temporaryRules);
          temp.delete(`usersig:${signalId}`);
          return { temporaryRules: temp, statusBar: statusSuccess(say("removed.userSignal", { id })) };
        });
        await get().loadSelectableSignals();
      }),

    setLabel: (entityType, id, name, description) =>
      reported(say(`settingLabel.${entityType}`, { id: hexId(id) }), async () => {
        await framelinkLabelSet(deviceId(), entityType, id, name, description);
        const tabMap = { frame_def: "frame-defs", generator: "generators", transformer: "transformers" } as const;
        await loadTab(tabMap[entityType]);
      }),

    selectItem: (id) => set({ selectedItemId: id }),
    clearError: () => set({ error: null }),
    setStatusBar: (entry) => set({ statusBar: entry }),
    reset: () => set({ ...initialState, temporaryRules: new Set() }),
  };
});

// Mirror every statusBar update into the bounded statusLog history.
// The Log tab reads from statusLog; the footer reads statusBar.
useRulesStore.subscribe((state, prev) => {
  if (state.statusBar && state.statusBar !== prev.statusBar) {
    const entry = state.statusBar;
    useRulesStore.setState((s) => {
      const log =
        s.statusLog.length >= STATUS_LOG_MAX
          ? s.statusLog.slice(-(STATUS_LOG_MAX - 1))
          : s.statusLog;
      return { statusLog: [...log, entry] };
    });
  }
});
