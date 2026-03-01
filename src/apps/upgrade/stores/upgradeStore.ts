// ui/src/apps/upgrade/stores/upgradeStore.ts

import { create } from "zustand";
import type { DiscoveredDevice, ImageSlotInfo, UploadProgress } from "../../../api/smpUpgrade";

export type UpgradeStep = "scan" | "inspect" | "upload" | "complete";
export type ConnectionState = "idle" | "connecting" | "connected" | "disconnecting";
export type UploadState =
  | "idle"
  | "reading"
  | "uploading"
  | "testing"
  | "resetting"
  | "confirming"
  | "error";

export interface PendingConnect {
  transport: "ble" | "udp";
  deviceId: string;
  deviceName: string;
  address?: string;
  port?: number;
}

interface UpgradeState {
  data: {
    /** Discovered devices (BLE and mDNS) */
    devices: DiscoveredDevice[];
    /** Currently selected device ID */
    selectedDeviceId: string | null;
    /** Selected device name (for display after disconnect) */
    selectedDeviceName: string | null;
    /** Transport type of the selected device */
    selectedDeviceTransport: "ble" | "udp" | null;
    /** Firmware image slot info from device */
    images: ImageSlotInfo[];
    /** Path to selected firmware file */
    selectedFilePath: string | null;
    /** Display name of selected firmware file */
    selectedFileName: string | null;
    /** File size in bytes */
    selectedFileSize: number | null;
    /** Upload progress from backend events */
    uploadProgress: UploadProgress | null;
    /** Pending auto-connect from provisioning CompleteView */
    pendingConnect: PendingConnect | null;
  };
  ui: {
    /** Current wizard step */
    step: UpgradeStep;
    /** Connection state */
    connectionState: ConnectionState;
    /** Upload/flash progress state */
    uploadState: UploadState;
    /** Whether scan is active */
    isScanning: boolean;
    /** Error message to display */
    error: string | null;
    /** Status message for progress display */
    statusMessage: string | null;
  };

  // Data actions
  addDevice: (device: DiscoveredDevice) => void;
  clearDevices: () => void;
  setSelectedDevice: (id: string | null, name: string | null, transport: "ble" | "udp" | null) => void;
  setImages: (images: ImageSlotInfo[]) => void;
  setSelectedFile: (path: string | null, name: string | null, size: number | null) => void;
  setUploadProgress: (progress: UploadProgress | null) => void;
  setPendingConnect: (pending: PendingConnect | null) => void;
  clearPendingConnect: () => void;

  // UI actions
  setStep: (step: UpgradeStep) => void;
  setConnectionState: (state: ConnectionState) => void;
  setUploadState: (state: UploadState) => void;
  setScanning: (scanning: boolean) => void;
  setError: (error: string | null) => void;
  setStatusMessage: (message: string | null) => void;

  /** Reset store to initial state */
  reset: () => void;
}

const initialData = {
  devices: [] as DiscoveredDevice[],
  selectedDeviceId: null as string | null,
  selectedDeviceName: null as string | null,
  selectedDeviceTransport: null as "ble" | "udp" | null,
  images: [] as ImageSlotInfo[],
  selectedFilePath: null as string | null,
  selectedFileName: null as string | null,
  selectedFileSize: null as number | null,
  uploadProgress: null as UploadProgress | null,
  pendingConnect: null as PendingConnect | null,
};

const initialUi = {
  step: "scan" as UpgradeStep,
  connectionState: "idle" as ConnectionState,
  uploadState: "idle" as UploadState,
  isScanning: false,
  error: null as string | null,
  statusMessage: null as string | null,
};

export const useUpgradeStore = create<UpgradeState>((set) => ({
  data: { ...initialData },
  ui: { ...initialUi },

  // ── Data actions ──

  addDevice: (device) =>
    set((s) => {
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

  setSelectedDevice: (id, name, transport) =>
    set((s) => ({
      data: {
        ...s.data,
        selectedDeviceId: id,
        selectedDeviceName: name,
        selectedDeviceTransport: transport,
      },
    })),

  setImages: (images) => set((s) => ({ data: { ...s.data, images } })),

  setSelectedFile: (path, name, size) =>
    set((s) => ({
      data: { ...s.data, selectedFilePath: path, selectedFileName: name, selectedFileSize: size },
    })),

  setUploadProgress: (progress) =>
    set((s) => ({ data: { ...s.data, uploadProgress: progress } })),

  setPendingConnect: (pending) =>
    set((s) => ({ data: { ...s.data, pendingConnect: pending } })),

  clearPendingConnect: () =>
    set((s) => ({ data: { ...s.data, pendingConnect: null } })),

  // ── UI actions ──

  setStep: (step) => set((s) => ({ ui: { ...s.ui, step } })),

  setConnectionState: (connectionState) =>
    set((s) => ({ ui: { ...s.ui, connectionState } })),

  setUploadState: (uploadState) =>
    set((s) => ({ ui: { ...s.ui, uploadState } })),

  setScanning: (isScanning) => set((s) => ({ ui: { ...s.ui, isScanning } })),

  setError: (error) => set((s) => ({ ui: { ...s.ui, error } })),

  setStatusMessage: (statusMessage) =>
    set((s) => ({ ui: { ...s.ui, statusMessage } })),

  reset: () => set({ data: { ...initialData }, ui: { ...initialUi } }),
}));
