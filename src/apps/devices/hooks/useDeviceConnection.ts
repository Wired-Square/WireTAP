// ui/src/apps/devices/hooks/useDeviceConnection.ts
//
// Centralised connect/disconnect lifecycle for the per-device tabs. Each
// tab calls the matching ensureXxx() on activation; the hook is idempotent
// — when a transport is already live the call is a no-op. The header back
// button calls disconnectAll() once, instead of every step view doing its
// own bespoke cleanup.
//
// React 19 StrictMode invokes effects twice in development, so each tab's
// useEffect calls ensureXxx() twice in quick succession. The flag check
// alone is racy (both invocations see "false" before either sets "true"),
// which on the BLE side caused a btleplug panic. We dedupe via a
// module-level in-flight Promise cache: the second caller awaits the same
// Promise as the first.

import { useCallback } from "react";
import { useDevicesStore } from "../stores/devicesStore";
import { useProvisioningStore } from "../../provisioning/stores/provisioningStore";
import { useUpgradeStore } from "../../upgrade/stores/upgradeStore";
import {
  bleConnect,
  bleDisconnect,
  bleReadDeviceState,
} from "../../../api/bleProvision";
import {
  smpAttachBle,
  smpConnectBle,
  smpConnectUdp,
  smpDisconnect,
} from "../../../api/smpUpgrade";

export interface DeviceConnection {
  /** Bring up BLE provisioning GATT, hydrate Wi-Fi state into provisioning store. */
  ensureBleProv: () => Promise<void>;
  /**
   * Bring up SMP. If BLE provisioning is already live we attach SMP onto the
   * same GATT link; otherwise we do a fresh BLE connect-and-attach.
   */
  ensureBleSmp: () => Promise<void>;
  /** Open SMP UDP transport to the selected device's address/port. */
  ensureIpSmp: () => Promise<void>;
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
let inflightBleSmp: Promise<void> | null = null;
let inflightIpSmp: Promise<void> | null = null;
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

        const setTransport = useDevicesStore.getState().setTransport;
        const setConnectionState = useDevicesStore.getState().setConnectionState;

        // macOS CoreBluetooth treats a peripheral as single-owner. If the SMP
        // module already grabbed the GATT, calling bleConnect on top would
        // panic btleplug. Drop SMP first.
        if (ui.transports.bleSmp) {
          try { await smpDisconnect(); } catch { /* ignore */ }
          setTransport("bleSmp", false);
        }

        setConnectionState("connecting");
        await bleConnect(data.selectedBleId);
        setTransport("bleProv", true);
        setConnectionState("connected");

        // Hydrate provisioning store with current Wi-Fi state — best-effort.
        try {
          const state = await bleReadDeviceState();
          const prov = useProvisioningStore.getState();
          prov.setSelectedDevice(data.selectedBleId, data.selectedDeviceName);
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

  const ensureBleSmp = useCallback(async () => {
    return dedupe(
      () => inflightBleSmp,
      (p) => { inflightBleSmp = p; },
      async () => {
        const { ui, data } = useDevicesStore.getState();
        if (ui.transports.bleSmp) return;
        if (!data.selectedBleId) {
          throw new Error("BLE not available for this device");
        }

        const setTransport = useDevicesStore.getState().setTransport;
        const setConnectionState = useDevicesStore.getState().setConnectionState;

        setConnectionState("connecting");
        if (ui.transports.bleProv) {
          await smpAttachBle();
        } else {
          await smpConnectBle(data.selectedBleId);
        }
        setTransport("bleSmp", true);
        setConnectionState("connected");

        const upgrade = useUpgradeStore.getState();
        upgrade.setSelectedDevice(data.selectedBleId, data.selectedDeviceName, "ble");
        upgrade.setConnectionState("connected");
      },
    );
  }, []);

  const ensureIpSmp = useCallback(async () => {
    return dedupe(
      () => inflightIpSmp,
      (p) => { inflightIpSmp = p; },
      async () => {
        const { ui, data } = useDevicesStore.getState();
        if (ui.transports.ipSmp) return;
        if (!data.selectedAddress || data.selectedSmpPort == null) {
          throw new Error("No SMP address/port for this device");
        }

        const setTransport = useDevicesStore.getState().setTransport;
        const setConnectionState = useDevicesStore.getState().setConnectionState;

        setConnectionState("connecting");
        await smpConnectUdp(data.selectedAddress, data.selectedSmpPort);
        setTransport("ipSmp", true);
        setConnectionState("connected");

        const upgrade = useUpgradeStore.getState();
        upgrade.setSelectedDevice(
          data.selectedDeviceId,
          data.selectedDeviceName,
          "udp",
        );
        upgrade.setConnectionState("connected");
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
        const { ui } = useDevicesStore.getState();

        if (ui.transports.bleSmp || ui.transports.ipSmp) {
          try { await smpDisconnect(); } catch { /* ignore */ }
        }
        if (ui.transports.bleProv || ui.transports.bleSmp) {
          try { await bleDisconnect(); } catch { /* ignore */ }
        }

        useDevicesStore.getState().resetTransports();
        useDevicesStore.getState().setConnectionState("idle");
        useProvisioningStore.getState().reset();
        useUpgradeStore.getState().reset();
      },
    );
  }, []);

  return {
    ensureBleProv,
    ensureBleSmp,
    ensureIpSmp,
    ensureIpFrameLink,
    disconnectAll,
  };
}
