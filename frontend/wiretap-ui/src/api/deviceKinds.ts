// src/api/deviceKinds.ts
//
// What each device kind's connection map defaults and requires, from Rust's
// `io::device_kinds` table.

import { invoke } from "@tauri-apps/api/core";
import type { IOProfile } from "../settings/appSettings";
import type { ProfileValidationError } from "../generated/ProfileValidationError";
import type { ValidationCode } from "../generated/ValidationCode";

export type { ProfileValidationError, ValidationCode };

export type ConnectionDefaults = Record<string, string | number | boolean>;

const defaultsByKind = new Map<string, Promise<ConnectionDefaults>>();

/** A kind's default connection map. Fixed for the build, so fetched once per kind. */
export function defaultConnectionForKind(kind: string): Promise<ConnectionDefaults> {
  let defaults = defaultsByKind.get(kind);
  if (!defaults) {
    defaults = invoke<ConnectionDefaults>("default_connection_for_kind", { kind });
    defaultsByKind.set(kind, defaults);
    defaults.catch(() => defaultsByKind.delete(kind));
  }
  return defaults;
}

/** Check a device against every saved and ad-hoc one; null when it is good. */
export function validateIOProfile(profile: IOProfile): Promise<ProfileValidationError | null> {
  return invoke<ProfileValidationError | null>("validate_io_profile", { profile });
}
