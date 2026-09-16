// src/hooks/useFrameLinkDeviceLiveness.ts
//
// Liveness signal for remembered FrameLink devices.
//
// Hybrid model:
//  - Background mDNS scan (deviceScanStart) updates "connectable" status as
//    devices advertise themselves on the network.
//  - probe(deviceId, host, port) is called lazily by the picker for any
//    profile that the scan has never seen (manually-typed hosts, devices
//    that don't advertise via mDNS, or "missing" devices the user wants to
//    re-check).
//
// State lives in a shared Zustand store so multiple consumers (today: Rules;
// tomorrow: any future panel that lists FrameLink devices) reuse the same
// scan stream and probe results.

import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  deviceScanStart,
  deviceScanStop,
  type UnifiedDevice,
} from "../api/deviceScan";
import { framelinkProbeDevice } from "../api/framelink";

export type FrameLinkLiveness = "unknown" | "probing" | "connectable" | "missing";

interface LivenessStoreState {
  scanRefs: number;
  unlisten: UnlistenFn | null;
  /** Indexed by capability device_id (e.g. "WiredFlexLink-9D04") */
  livenessByDeviceId: Map<string, FrameLinkLiveness>;
  /** Indexed by `${host}:${port}` — fallback for profiles without device_id */
  livenessByHostPort: Map<string, FrameLinkLiveness>;
}

interface LivenessStoreActions {
  startScan: () => Promise<void>;
  stopScan: () => Promise<void>;
  markDiscovered: (device: UnifiedDevice) => void;
  probe: (deviceId: string, host: string, port: number) => Promise<void>;
}

const useFrameLinkLivenessStore = create<LivenessStoreState & LivenessStoreActions>(
  (set, get) => ({
    scanRefs: 0,
    unlisten: null,
    livenessByDeviceId: new Map(),
    livenessByHostPort: new Map(),

    startScan: async () => {
      const refs = get().scanRefs + 1;
      set({ scanRefs: refs });
      if (refs > 1) return; // already running for another consumer

      const unlisten = await listen<UnifiedDevice>(
        "device-discovered",
        (event) => get().markDiscovered(event.payload),
      );
      set({ unlisten });

      try {
        await deviceScanStart();
      } catch {
        // Tolerate "already scanning" — another part of the app may have
        // started it (e.g. the Devices panel).
      }
    },

    stopScan: async () => {
      const refs = Math.max(0, get().scanRefs - 1);
      set({ scanRefs: refs });
      if (refs > 0) return; // other consumers still want the scan

      const u = get().unlisten;
      if (u) u();
      set({ unlisten: null });

      try {
        await deviceScanStop();
      } catch {
        // Tolerate — another part of the app may still be scanning.
      }
    },

    markDiscovered: (d) => {
      if (!d.capabilities.includes("framelink")) return;
      set((s) => {
        const next = new Map(s.livenessByDeviceId);
        next.set(d.id, "connectable");
        let nextHostPort = s.livenessByHostPort;
        if (d.address && d.port != null) {
          nextHostPort = new Map(s.livenessByHostPort);
          nextHostPort.set(`${d.address}:${d.port}`, "connectable");
        }
        return {
          livenessByDeviceId: next,
          livenessByHostPort: nextHostPort,
        };
      });
    },

    probe: async (deviceId, host, port) => {
      set((s) => {
        const next = new Map(s.livenessByDeviceId);
        next.set(deviceId, "probing");
        return { livenessByDeviceId: next };
      });
      try {
        await framelinkProbeDevice(host, port, 1500);
        set((s) => {
          const next = new Map(s.livenessByDeviceId);
          next.set(deviceId, "connectable");
          const nextHost = new Map(s.livenessByHostPort);
          nextHost.set(`${host}:${port}`, "connectable");
          return {
            livenessByDeviceId: next,
            livenessByHostPort: nextHost,
          };
        });
      } catch {
        set((s) => {
          const next = new Map(s.livenessByDeviceId);
          next.set(deviceId, "missing");
          return { livenessByDeviceId: next };
        });
      }
    },
  }),
);

export interface UseFrameLinkDeviceLivenessResult {
  /** Liveness keyed by capability device_id. */
  livenessByDeviceId: Map<string, FrameLinkLiveness>;
  /** Liveness keyed by `${host}:${port}` — covers profiles with no device_id. */
  livenessByHostPort: Map<string, FrameLinkLiveness>;
  /** Lazy probe for a remembered device. Updates the store on resolution. */
  probe: (deviceId: string, host: string, port: number) => Promise<void>;
}

/**
 * Subscribe to live FrameLink-device status. Starts the unified mDNS scan
 * on mount (ref-counted across consumers) and stops it on unmount.
 *
 * The hook does NOT auto-probe. Callers (typically the picker popover)
 * decide when to probe a specific profile via `probe(...)`.
 */
export function useFrameLinkDeviceLiveness(): UseFrameLinkDeviceLivenessResult {
  const { livenessByDeviceId, livenessByHostPort, probe, startScan, stopScan } =
    useFrameLinkLivenessStore(
      useShallow((s) => ({
        livenessByDeviceId: s.livenessByDeviceId,
        livenessByHostPort: s.livenessByHostPort,
        probe: s.probe,
        startScan: s.startScan,
        stopScan: s.stopScan,
      })),
    );

  useEffect(() => {
    void startScan();
    return () => {
      void stopScan();
    };
  }, [startScan, stopScan]);

  return { livenessByDeviceId, livenessByHostPort, probe };
}
