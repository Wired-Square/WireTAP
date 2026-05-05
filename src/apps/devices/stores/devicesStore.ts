// ui/src/apps/devices/stores/devicesStore.ts
//
// Lightweight store for the unified Devices tab. Two screens — scan and the
// per-device tabbed page. Per-tab data (provisioning credentials, firmware
// upload progress, etc.) lives in provisioningStore and upgradeStore.

import { create } from "zustand";
import type { UnifiedDevice } from "../../../api/deviceScan";

// ============================================================================
// Types
// ============================================================================

export type DevicesScreen = "scan" | "device";

export type DeviceTabId =
  | "wifi"
  | "firmware-ble"
  | "firmware-ip"
  | "dataio";

export type ConnectionState = "idle" | "connecting" | "connected";

/**
 * Tracks which transports/protocols are live. Used by useDeviceConnection
 * so each tab's ensureXxx() call is idempotent.
 */
export interface TransportsConnected {
  /** BLE GATT link for WiFi provisioning service. */
  bleProv: boolean;
  /** SMP layer attached to the BLE link (either via fresh connect or attach). */
  bleSmp: boolean;
  /** UDP SMP transport. */
  ipSmp: boolean;
  /** FrameLink probe completed (no persistent socket). */
  ipFrameLink: boolean;
}

// ============================================================================
// Store
// ============================================================================

interface DevicesState {
  data: {
    /** Discovered devices (BLE + mDNS) */
    devices: UnifiedDevice[];
    /** Currently selected device ID (transport-prefixed: ble:..., udp:..., fl:...) */
    selectedDeviceId: string | null;
    /** Selected device name (for display) */
    selectedDeviceName: string | null;
    /**
     * BLE peripheral ID for the selected device, if one was discovered. Used
     * by Wi-Fi and Firmware (BLE) tabs to (re)connect.
     */
    selectedBleId: string | null;
    /** Selected device IP address (mDNS or manual) */
    selectedAddress: string | null;
    /** framelink::DeviceId for the SMP-UDP transport (mDNS-discovered). */
    selectedSmpId: string | null;
    /** Selected device SMP UDP port (mDNS or manual). */
    selectedSmpPort: number | null;
    /** FrameLink TCP port (defaults to 120). */
    selectedFrameLinkPort: number | null;
    /** Selected device capabilities (from mDNS + BLE merged). */
    selectedCapabilities: string[];
  };
  ui: {
    /** Top-level screen — scan list or per-device tabbed page. */
    screen: DevicesScreen;
    /** Active tab on the device page. */
    activeTab: DeviceTabId;
    /** Connection state (any live transport → "connected"). */
    connectionState: ConnectionState;
    /** Per-transport connection flags. */
    transports: TransportsConnected;
    /** Whether scanning is active */
    isScanning: boolean;
    /** Error message */
    error: string | null;
  };

  // Data actions
  addDevice: (device: UnifiedDevice) => void;
  /**
   * Remove all UnifiedDevice entries with this framelink `DeviceId`. A
   * single physical device can have several entries (one per transport)
   * sharing the same id prefix scheme but distinct ids — only the
   * matching one is removed. Driven by Discovery's `Lost` event.
   */
  removeDevice: (id: string) => void;
  clearDevices: () => void;
  /** Drop entries whose lastSeenAt is older than (now - olderThanMs). */
  pruneStale: (olderThanMs: number) => void;
  /**
   * Capture the device the user is about to interact with. The fields that
   * are null get filled in as discovery sources confirm them.
   */
  selectDevice: (selection: {
    id: string;
    name: string;
    bleId: string | null;
    address: string | null;
    smpId: string | null;
    smpPort: number | null;
    frameLinkPort: number | null;
    capabilities: string[];
  }) => void;

  // UI actions
  setScreen: (screen: DevicesScreen) => void;
  setActiveTab: (tab: DeviceTabId) => void;
  setConnectionState: (state: ConnectionState) => void;
  setTransport: (key: keyof TransportsConnected, value: boolean) => void;
  resetTransports: () => void;
  setScanning: (scanning: boolean) => void;
  setError: (error: string | null) => void;

  /** Reset store to initial state */
  reset: () => void;
}

const initialData = {
  devices: [] as UnifiedDevice[],
  selectedDeviceId: null as string | null,
  selectedDeviceName: null as string | null,
  selectedBleId: null as string | null,
  selectedAddress: null as string | null,
  selectedSmpId: null as string | null,
  selectedSmpPort: null as number | null,
  selectedFrameLinkPort: null as number | null,
  selectedCapabilities: [] as string[],
};

const initialTransports: TransportsConnected = {
  bleProv: false,
  bleSmp: false,
  ipSmp: false,
  ipFrameLink: false,
};

const initialUi = {
  screen: "scan" as DevicesScreen,
  activeTab: "wifi" as DeviceTabId,
  connectionState: "idle" as ConnectionState,
  transports: { ...initialTransports },
  isScanning: false,
  error: null as string | null,
};

export const useDevicesStore = create<DevicesState>((set) => ({
  data: { ...initialData },
  ui: { ...initialUi },

  // ── Data actions ──

  addDevice: (device) =>
    set((s) => {
      const now = Date.now();
      // Update if already seen (merge capabilities and transport-specific fields), otherwise add
      const existing = s.data.devices.find((d) => d.id === device.id);
      if (existing) {
        const mergedCaps = [...new Set([...(existing.capabilities ?? []), ...(device.capabilities ?? [])])];
        return {
          data: {
            ...s.data,
            devices: s.data.devices.map((d) =>
              d.id === device.id ? {
                ...d,
                rssi: device.rssi ?? d.rssi,
                name: device.name,
                ble_id: device.ble_id ?? d.ble_id,
                address: device.address ?? d.address,
                port: device.port ?? d.port,
                capabilities: mergedCaps,
                lastSeenAt: now,
              } : d,
            ),
          },
        };
      }
      return {
        data: {
          ...s.data,
          devices: [...s.data.devices, { ...device, lastSeenAt: now }],
        },
      };
    }),

  removeDevice: (id) =>
    set((s) => {
      const next = s.data.devices.filter((d) => d.id !== id);
      if (next.length === s.data.devices.length) return s;
      return { data: { ...s.data, devices: next } };
    }),

  clearDevices: () => set((s) => ({ data: { ...s.data, devices: [] } })),

  pruneStale: (olderThanMs) =>
    set((s) => {
      const cutoff = Date.now() - olderThanMs;
      const next = s.data.devices.filter((d) => (d.lastSeenAt ?? cutoff) >= cutoff);
      if (next.length === s.data.devices.length) return s;
      return { data: { ...s.data, devices: next } };
    }),

  selectDevice: (selection) =>
    set((s) => ({
      data: {
        ...s.data,
        selectedDeviceId: selection.id,
        selectedDeviceName: selection.name,
        selectedBleId: selection.bleId,
        selectedAddress: selection.address,
        selectedSmpId: selection.smpId,
        selectedSmpPort: selection.smpPort,
        selectedFrameLinkPort: selection.frameLinkPort,
        selectedCapabilities: selection.capabilities,
      },
    })),

  // ── UI actions ──

  setScreen: (screen) => set((s) => ({ ui: { ...s.ui, screen } })),

  setActiveTab: (activeTab) => set((s) => ({ ui: { ...s.ui, activeTab } })),

  setConnectionState: (connectionState) =>
    set((s) => ({ ui: { ...s.ui, connectionState } })),

  setTransport: (key, value) =>
    set((s) => ({
      ui: {
        ...s.ui,
        transports: { ...s.ui.transports, [key]: value },
      },
    })),

  resetTransports: () =>
    set((s) => ({ ui: { ...s.ui, transports: { ...initialTransports } } })),

  setScanning: (isScanning) => set((s) => ({ ui: { ...s.ui, isScanning } })),

  setError: (error) => set((s) => ({ ui: { ...s.ui, error } })),

  reset: () => set({ data: { ...initialData }, ui: { ...initialUi } }),
}));
