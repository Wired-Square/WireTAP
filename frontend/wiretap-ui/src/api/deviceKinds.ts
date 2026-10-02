// src/api/deviceKinds.ts
//
// What each device kind's connection map defaults and requires, and what each
// kind and profile can do, from Rust's `io::device_kinds` table.

import { invoke } from "@tauri-apps/api/core";
import type { IOProfile } from "../settings/appSettings";
import type { ProfileValidationError } from "../generated/ProfileValidationError";
import type { ValidationCode } from "../generated/ValidationCode";
import type { ProfileTraitsTable } from "../generated/ProfileTraitsTable";
import type { ProfileTraits } from "../generated/ProfileTraits";
import type { KindTraits } from "../generated/KindTraits";

export type { ProfileValidationError, ValidationCode, ProfileTraitsTable, ProfileTraits, KindTraits };

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

/** Every kind's traits in kind-picker order, and every saved or ad-hoc profile's. */
export function listProfileTraits(): Promise<ProfileTraitsTable> {
  return invoke<ProfileTraitsTable>("list_profile_traits");
}

/** Why these profiles cannot open as one session; null when they can. */
export function validateSourceSelection(profiles: IOProfile[]): Promise<string | null> {
  return invoke<string | null>("validate_source_selection", { profiles });
}
