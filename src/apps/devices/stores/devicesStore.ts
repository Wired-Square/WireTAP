// ui/src/apps/devices/stores/devicesStore.ts
//
// Lightweight store for the unified Devices tab. Manages the scan phase
// and overall wizard step. Sub-workflow state (provisioning credentials,
// firmware upload progress, etc.) remains in provisioningStore and
// upgradeStore respectively.

import { create } from "zustand";
import type { UnifiedDevice } from "../../../api/deviceScan";

// ============================================================================
// Types
// ============================================================================

export type DevicesStep =
  | "scan"
  // Provisioning sub-flow
  | "credentials"
  | "provisioning"
  | "provision-complete"
  // Upgrade sub-flow
  | "inspect"
  | "upload"
  | "upgrade-complete";

export type ConnectionState = "idle" | "connecting" | "connected";

// ============================================================================
// Store
// ============================================================================

interface DevicesState {
  data: {
    /** Discovered devices (BLE + mDNS) */
    devices: UnifiedDevice[];
    /** Currently selected device ID */
    selectedDeviceId: string | null;
    /** Selected device name (for display) */
    selectedDeviceName: string | null;
    /** Selected device transport */
    selectedDeviceTransport: "ble" | "udp" | null;
    /** Selected device capabilities */
    selectedDeviceCapabilities: string[];
  };
  ui: {
    /** Current wizard step */
    step: DevicesStep;
    /** Connection state */
    connectionState: ConnectionState;
    /** Whether scanning is active */
    isScanning: boolean;
    /** Error message */
    error: string | null;
  };

  // Data actions
  addDevice: (device: UnifiedDevice) => void;
  clearDevices: () => void;
  setSelectedDevice: (
    id: string | null,
    name: string | null,
    transport: "ble" | "udp" | null,
    capabilities: string[],
  ) => void;

  // UI actions
  setStep: (step: DevicesStep) => void;
  setConnectionState: (state: ConnectionState) => void;
  setScanning: (scanning: boolean) => void;
  setError: (error: string | null) => void;

  /** Reset store to initial state */
  reset: () => void;
}

const initialData = {
  devices: [] as UnifiedDevice[],
  selectedDeviceId: null as string | null,
  selectedDeviceName: null as string | null,
  selectedDeviceTransport: null as "ble" | "udp" | null,
  selectedDeviceCapabilities: [] as string[],
};

const initialUi = {
  step: "scan" as DevicesStep,
  connectionState: "idle" as ConnectionState,
  isScanning: false,
  error: null as string | null,
};

export const useDevicesStore = create<DevicesState>((set) => ({
  data: { ...initialData },
  ui: { ...initialUi },

  // ── Data actions ──

  addDevice: (device) =>
    set((s) => {
      // Update if already seen, otherwise add
      const existing = s.data.devices.find((d) => d.id === device.id);
      if (existing) {
        return {
          data: {
            ...s.data,
            devices: s.data.devices.map((d) =>
              d.id === device.id ? { ...d, rssi: device.rssi, name: device.name } : d,
            ),
          },
        };
      }
      return { data: { ...s.data, devices: [...s.data.devices, device] } };
    }),

  clearDevices: () => set((s) => ({ data: { ...s.data, devices: [] } })),

  setSelectedDevice: (id, name, transport, capabilities) =>
    set((s) => ({
      data: {
        ...s.data,
        selectedDeviceId: id,
        selectedDeviceName: name,
        selectedDeviceTransport: transport,
        selectedDeviceCapabilities: capabilities,
      },
    })),

  // ── UI actions ──

  setStep: (step) => set((s) => ({ ui: { ...s.ui, step } })),

  setConnectionState: (connectionState) =>
    set((s) => ({ ui: { ...s.ui, connectionState } })),

  setScanning: (isScanning) => set((s) => ({ ui: { ...s.ui, isScanning } })),

  setError: (error) => set((s) => ({ ui: { ...s.ui, error } })),

  reset: () => set({ data: { ...initialData }, ui: { ...initialUi } }),
}));
