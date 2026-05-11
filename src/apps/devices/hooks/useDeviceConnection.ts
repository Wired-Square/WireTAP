// ui/src/apps/devices/hooks/useDeviceConnection.ts
//
// Per-device-tab activation hooks. Each tab calls the matching
// ensureXxx() on mount; framelink-rs's `Discovery` is the single
// source of truth for sessions, so these calls just warm its cache
// (idempotent — repeat calls hand back the same session). Tear-down
// is the unified `releaseDevice(deviceId)` exposed via
// `disconnectAll`, called once when the user actually leaves the
// device.
//
// React 19 StrictMode invokes effects twice in development, so each
// tab's useEffect calls ensureXxx() twice in quick succession. The
// dedupe below collapses the duplicate so we don't fire two parallel
// open requests at framelink-rs.

import { useCallback } from "react";
import { useDevicesStore } from "../stores/devicesStore";
import { useProvisioningStore } from "../../provisioning/stores/provisioningStore";
import {
  bleConnect,
  bleReadDeviceState,
} from "../../../api/bleProvision";
import { releaseDevice } from "../../../api/deviceScan";

export interface DeviceConnection {
  /** Bring up BLE provisioning GATT, hydrate Wi-Fi state into provisioning store. */
  ensureBleProv: () => Promise<void>;
  /**
   * Mark FrameLink as ready. There's no persistent FrameLink socket — the
   * probe call inside DataIoTab is what actually proves reachability.
   */
  ensureIpFrameLink: () => Promise<void>;
  /** Tear down every live transport. Safe to call when nothing is connected. */
  disconnectAll: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// In-flight dedupe — module-level so it spans StrictMode double-mount and
// every hook instance.
// ---------------------------------------------------------------------------

let inflightBleProv: Promise<void> | null = null;
let inflightIpFrameLink: Promise<void> | null = null;
let inflightDisconnect: Promise<void> | null = null;

function dedupe<T>(
  ref: () => Promise<T> | null,
  set: (p: Promise<T> | null) => void,
  build: () => Promise<T>,
): Promise<T> {
  const existing = ref();
  if (existing) return existing;
  const p = (async () => {
    try {
      return await build();
    } finally {
      set(null);
    }
  })();
  set(p);
  return p;
}

export function useDeviceConnection(): DeviceConnection {
  const ensureBleProv = useCallback(async () => {
    return dedupe(
      () => inflightBleProv,
      (p) => { inflightBleProv = p; },
      async () => {
        const { ui, data } = useDevicesStore.getState();
        if (ui.transports.bleProv) return;
        if (!data.selectedBleId) {
          throw new Error("BLE not available for this device");
        }
        const deviceId = data.selectedBleId;

        const setTransport = useDevicesStore.getState().setTransport;
        const setConnectionState = useDevicesStore.getState().setConnectionState;

        setConnectionState("connecting");
        await bleConnect(deviceId);
        setTransport("bleProv", true);
        setConnectionState("connected");

        // Hydrate provisioning store with current Wi-Fi state — best-effort.
        try {
          const state = await bleReadDeviceState(deviceId);
          const prov = useProvisioningStore.getState();
          prov.setSelectedDevice(deviceId, data.selectedDeviceName);
          prov.setConnectionState("connected");
          if (state.ssid) {
            prov.setDeviceSsid(state.ssid);
            prov.setSsid(state.ssid);
          }
          if (state.security != null) prov.setSecurity(state.security);
          prov.setDeviceStatus(state.status);
          if (state.ip_address) prov.setDeviceIpAddress(state.ip_address);
        } catch {
          // Non-critical
        }
      },
    );
  }, []);

  const ensureIpFrameLink = useCallback(async () => {
    return dedupe(
      () => inflightIpFrameLink,
      (p) => { inflightIpFrameLink = p; },
      async () => {
        const { ui, data } = useDevicesStore.getState();
        if (ui.transports.ipFrameLink) return;
        if (!data.selectedAddress) {
          throw new Error("No FrameLink address for this device");
        }
        useDevicesStore.getState().setTransport("ipFrameLink", true);
      },
    );
  }, []);

  const disconnectAll = useCallback(async () => {
    return dedupe(
      () => inflightDisconnect,
      (p) => { inflightDisconnect = p; },
      async () => {
        const { data } = useDevicesStore.getState();

        // Single tear-down call per transport-id. framelink-rs drops
        // the cached sessions; the lease's strong count falls to zero
        // once any in-flight operation releases its local clone, which
        // is when the BLE link actually closes.
        if (data.selectedBleId) {
          try { await releaseDevice(data.selectedBleId); } catch { /* ignore */ }
        }
        if (data.selectedSmpId) {
          try { await releaseDevice(data.selectedSmpId); } catch { /* ignore */ }
        }

        useDevicesStore.getState().resetTransports();
        useDevicesStore.getState().setConnectionState("idle");
        useProvisioningStore.getState().reset();
      },
    );
  }, []);

  return {
    ensureBleProv,
    ensureIpFrameLink,
    disconnectAll,
  };
}
