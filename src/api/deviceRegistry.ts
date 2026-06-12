// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// Device registry — WS command wrappers over the framelink-rs registry.
// The registry is the single source of truth for which devices exist and
// how to reach them: `auto` resolves the address via mDNS at connect time,
// `manual` always connects to a stored host and never discovers. This is
// distinct from IO Profiles, which describe a device's capabilities and
// data-source configuration.

import { wsTransport } from "../services/wsTransport";

export type Resolution = "auto" | "manual";

/** Mirrors framelink::DeviceRecord. `host` is null for `auto` records. */
export interface DeviceRegistryEntry {
  device_id: string;
  resolution: Resolution;
  host: string | null;
  framelink_port: number;
  smp_port: number;
}

/** List every registered device. */
export function registryList(): Promise<DeviceRegistryEntry[]> {
  return wsTransport.command("registry.list", {});
}

/** Fetch one device's record, or null if not registered. */
export function registryGet(deviceId: string): Promise<DeviceRegistryEntry | null> {
  return wsTransport.command("registry.get", { device_id: deviceId });
}

/**
 * Pin `deviceId` to `host` (Manual) — the stored host is used for every
 * transport, never discovered. Optional ports override the defaults
 * (FrameLink-TCP 120, SMP-UDP 1337).
 */
export function registrySetManual(
  deviceId: string,
  host: string,
  ports?: { framelinkPort?: number; smpPort?: number },
): Promise<void> {
  return wsTransport.command("registry.upsert", {
    device_id: deviceId,
    resolution: "manual",
    host,
    framelink_port: ports?.framelinkPort ?? null,
    smp_port: ports?.smpPort ?? null,
  });
}

/** Restore mDNS resolution for `deviceId` (Auto) — clears the stored host. */
export function registrySetAuto(deviceId: string): Promise<void> {
  return wsTransport.command("registry.upsert", {
    device_id: deviceId,
    resolution: "auto",
  });
}

/** Remove a device from the registry. */
export function registryRemove(deviceId: string): Promise<void> {
  return wsTransport.command("registry.remove", { device_id: deviceId });
}
