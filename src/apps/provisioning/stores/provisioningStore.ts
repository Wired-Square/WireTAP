// ui/src/apps/provisioning/stores/provisioningStore.ts

import { create } from "zustand";
import type { BleDevice } from "../../../api/bleProvision";

export type ProvisioningStep = "scan" | "credentials" | "provisioning" | "complete";
export type ConnectionState = "idle" | "connecting" | "connected" | "disconnecting";
export type ProvisionState = "idle" | "writing" | "waiting" | "connected" | "error";

interface ProvisioningState {
  data: {
    /** Discovered BLE devices */
    devices: BleDevice[];
    /** Currently selected device ID */
    selectedDeviceId: string | null;
    /** Selected device name (for display after disconnect) */
    selectedDeviceName: string | null;
    /** Current WiFi SSID read from device */
    deviceSsid: string | null;
    /** Device WiFi connection status (from Status characteristic) */
    deviceStatus: number | undefined;
    /** Device IP address (from IP address characteristic) */
    deviceIpAddress: string | null;
    /** Host machine's current WiFi SSID */
    hostSsid: string | null;
    /** WiFi credentials form */
    ssid: string;
    passphrase: string;
    /** Security type: 0 = Open, 2 = WPA2-PSK */
    security: number;
  };
  ui: {
    /** Current wizard step */
    step: ProvisioningStep;
    /** BLE connection state */
    connectionState: ConnectionState;
    /** Provisioning progress state */
    provisionState: ProvisionState;
    /** Whether BLE scan is active */
    isScanning: boolean;
    /** Error message to display */
    error: string | null;
    /** Status message for the provisioning step */
    statusMessage: string | null;
  };

  // Data actions
  addDevice: (device: BleDevice) => void;
  updateDeviceRssi: (id: string, rssi: number | null) => void;
  clearDevices: () => void;
  setSelectedDevice: (id: string | null, name: string | null) => void;
  setDeviceSsid: (ssid: string | null) => void;
  setDeviceStatus: (status: number | undefined) => void;
  setHostSsid: (ssid: string | null) => void;
  setDeviceIpAddress: (ip: string | null) => void;
  setSsid: (ssid: string) => void;
  setPassphrase: (passphrase: string) => void;
  setSecurity: (security: number) => void;

  // UI actions
  setStep: (step: ProvisioningStep) => void;
  setConnectionState: (state: ConnectionState) => void;
  setProvisionState: (state: ProvisionState) => void;
  setScanning: (scanning: boolean) => void;
  setError: (error: string | null) => void;
  setStatusMessage: (message: string | null) => void;

  /** Reset store to initial state */
  reset: () => void;
}

const initialData = {
  devices: [] as BleDevice[],
  selectedDeviceId: null as string | null,
  selectedDeviceName: null as string | null,
  deviceSsid: null as string | null,
  deviceStatus: undefined as number | undefined,
  deviceIpAddress: null as string | null,
  hostSsid: null as string | null,
  ssid: "",
  passphrase: "",
  security: 2, // WPA2-PSK default
};

const initialUi = {
  step: "scan" as ProvisioningStep,
  connectionState: "idle" as ConnectionState,
  provisionState: "idle" as ProvisionState,
  isScanning: false,
  error: null as string | null,
  statusMessage: null as string | null,
};

export const useProvisioningStore = create<ProvisioningState>((set) => ({
  data: { ...initialData },
  ui: { ...initialUi },

  // ── Data actions ──

  addDevice: (device) =>
    set((s) => {
      // Update RSSI if device already seen, otherwise add
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

  updateDeviceRssi: (id, rssi) =>
    set((s) => ({
      data: {
        ...s.data,
        devices: s.data.devices.map((d) => (d.id === id ? { ...d, rssi } : d)),
      },
    })),

  clearDevices: () => set((s) => ({ data: { ...s.data, devices: [] } })),

  setSelectedDevice: (id, name) =>
    set((s) => ({ data: { ...s.data, selectedDeviceId: id, selectedDeviceName: name } })),

  setDeviceSsid: (ssid) => set((s) => ({ data: { ...s.data, deviceSsid: ssid } })),

  setDeviceStatus: (status) => set((s) => ({ data: { ...s.data, deviceStatus: status } })),

  setDeviceIpAddress: (ip) => set((s) => ({ data: { ...s.data, deviceIpAddress: ip } })),

  setHostSsid: (ssid) => set((s) => ({ data: { ...s.data, hostSsid: ssid } })),

  setSsid: (ssid) => set((s) => ({ data: { ...s.data, ssid } })),

  setPassphrase: (passphrase) => set((s) => ({ data: { ...s.data, passphrase } })),

  setSecurity: (security) => set((s) => ({ data: { ...s.data, security } })),

  // ── UI actions ──

  setStep: (step) => set((s) => ({ ui: { ...s.ui, step } })),

  setConnectionState: (connectionState) =>
    set((s) => ({ ui: { ...s.ui, connectionState } })),

  setProvisionState: (provisionState) =>
    set((s) => ({ ui: { ...s.ui, provisionState } })),

  setScanning: (isScanning) => set((s) => ({ ui: { ...s.ui, isScanning } })),

  setError: (error) => set((s) => ({ ui: { ...s.ui, error } })),

  setStatusMessage: (statusMessage) =>
    set((s) => ({ ui: { ...s.ui, statusMessage } })),

  reset: () => set({ data: { ...initialData }, ui: { ...initialUi } }),
}));
