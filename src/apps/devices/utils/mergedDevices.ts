// ui/src/apps/devices/utils/mergedDevices.ts
//
// Groups the per-transport UnifiedDevice entries from devicesStore into one
// MergedDevice per physical device, keyed by name. A BLE entry whose name
// hasn't resolved yet (still the raw MAC) sits in its own bucket until the
// scanner re-emits with the proper name; the next merge run then folds it
// into the named bucket automatically.

import type { UnifiedDevice } from "../../../api/deviceScan";

export interface MergedBle {
  id: string;
  rssi: number | null;
  capabilities: string[];
  lastSeenAt: number;
}

export interface MergedNetwork {
  address: string;
  port: number;
  lastSeenAt: number;
}

export interface MergedDevice {
  name: string;
  ble: MergedBle | null;
  smp: MergedNetwork | null;
  framelink: MergedNetwork | null;
}

export function mergeDevices(devices: UnifiedDevice[]): MergedDevice[] {
  const byName = new Map<string, MergedDevice>();

  for (const d of devices) {
    let m = byName.get(d.name);
    if (!m) {
      m = { name: d.name, ble: null, smp: null, framelink: null };
      byName.set(d.name, m);
    }

    const lastSeenAt = d.lastSeenAt ?? Date.now();

    if (d.transport === "ble" && d.ble_id) {
      m.ble = {
        id: d.ble_id,
        rssi: d.rssi,
        capabilities: d.capabilities,
        lastSeenAt,
      };
    } else if (d.transport === "udp" && d.address && d.port != null) {
      m.smp = { address: d.address, port: d.port, lastSeenAt };
    } else if (d.transport === "tcp" && d.address && d.port != null) {
      m.framelink = { address: d.address, port: d.port, lastSeenAt };
    }
  }

  return [...byName.values()];
}

export function bleHasCap(m: MergedDevice, cap: string): boolean {
  return m.ble?.capabilities.includes(cap) ?? false;
}

export function preferredAddress(m: MergedDevice): string | null {
  return m.framelink?.address ?? m.smp?.address ?? null;
}
