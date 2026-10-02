// src/settings/devices.ts
//
// Creating a device is Rust's `create_device`: it mints the id, fills the kind's
// defaults, validates against every saved and ad-hoc device, and stores the
// secrets and the profile. This module brings the stores in line with it.

import { createDevice, isProfileValidationError, type DeviceDraft } from "../api/ephemeralProfiles";
import type { ProfileValidationError } from "../generated/ProfileValidationError";
import type { IOProfile } from "./appSettings";
import { useSettingsStore } from "../apps/settings/stores/settingsStore";
import { useAdHocProfileStore } from "../stores/adHocProfileStore";
import { useProfileBusStore } from "../stores/profileBusStore";

/**
 * Create a device and show it in the settings or ad-hoc store. A saved one is
 * already on disk, so once the rebase on the backend's write lands, the
 * settings store has nothing left to save.
 */
export async function addDevice(draft: DeviceDraft, persist: boolean): Promise<IOProfile> {
  const device = await createDevice(draft, persist);
  if (persist) {
    useSettingsStore.getState().addProfile(device);
  } else {
    await useAdHocProfileStore.getState().refresh();
    useProfileBusStore.getState().invalidate();
  }
  return device;
}

/** A device write's rejection as text, a rule's through `describe`. */
export function deviceWriteMessage(e: unknown, describe: (invalid: ProfileValidationError) => string): string {
  if (isProfileValidationError(e)) return describe(e);
  return e instanceof Error ? e.message : String(e);
}

/** `base`, numbered past any name in `taken`. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base} (${n})`;
  return name;
}
