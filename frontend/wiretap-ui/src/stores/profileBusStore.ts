// src/stores/profileBusStore.ts
//
// Cache of the bus mappings each IO profile declares, and of the traits Rust
// serves for every kind and profile.
//
// Rust owns the enumeration (`sessions::profile_bus_mappings`) because it reads
// the same `connection.interfaces` the readers do. This store fetches that once
// and hands it out synchronously, so the source picker and the session graph
// don't have to become async to know how many buses a device has.
//
// Do not re-derive a profile's bus list anywhere else — a second implementation
// in the frontend drifted out of step and shipped a 2-bus GVRET as a single bus.

import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  getProfileBusMappings,
  getSupportedProtocols,
  offsetBusMappings,
  type BusMapping,
  type Protocol,
} from "../api/io";
import { listProfileTraits, type KindTraits, type ProfileTraits } from "../api/deviceKinds";
import type { IOProfile } from "../settings/appSettings";
import { WINDOW_EVENTS } from "../events/registry";

interface ProfileBusState {
  /** profileId → declared mappings, output buses numbered densely from 0 */
  mappings: Map<string, BusMapping[]>;
  /** profile kind → the protocols one of its buses may be set to */
  supportedProtocols: Map<string, Protocol[]>;
  /** profileId → what the profile can do, read off its connection map */
  traits: Map<string, ProfileTraits>;
  /** every kind, in kind-picker order, as a profile with nothing configured */
  kinds: KindTraits[];
  loaded: boolean;

  /** Fetch from Rust. Concurrent calls share one round trip. */
  refresh: () => Promise<void>;
  /** Fetch once; a no-op while the cache is still valid. */
  ensureLoaded: () => Promise<void>;
  /** Drop the cache so the next `ensureLoaded` refetches. */
  invalidate: () => void;
}

/** Shared by concurrent refresh callers so a burst makes one round trip. */
let inFlight: Promise<void> | null = null;

export const useProfileBusStore = create<ProfileBusState>((set, get) => ({
  mappings: new Map(),
  supportedProtocols: new Map(),
  traits: new Map(),
  kinds: [],
  loaded: false,

  refresh: (): Promise<void> => {
    if (inFlight) return inFlight;
    // One await for both: the picker needs the protocol options in the same
    // render it needs the bus list, and neither is useful without the other.
    //
    // The protocol table is compiled into Rust and cannot change while the app
    // runs, so it is fetched once per window and kept across the invalidations
    // that settings edits trigger — only the mappings actually go stale.
    const cached = get().supportedProtocols;
    inFlight = Promise.all([
      getProfileBusMappings(),
      cached.size > 0 ? cached : getSupportedProtocols(),
      listProfileTraits(),
    ])
      .then(([mappings, supportedProtocols, table]) => {
        set({
          mappings,
          supportedProtocols,
          traits: new Map(Object.entries(table.profiles)),
          kinds: table.kinds,
          loaded: true,
        });
      })
      .catch((error: unknown) => {
        console.error("[profileBusStore] Failed to load profile bus mappings:", error);
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  },

  ensureLoaded: (): Promise<void> => (get().loaded ? Promise.resolve() : get().refresh()),

  invalidate: () => set({ loaded: false }),
}));

// A profile's interfaces change under us when the user edits it in Settings, or
// when an ad-hoc device is registered. Both land as a settings broadcast, so the
// cache invalidates itself rather than every consumer remembering to refresh.
// Module scope, not a component: a stale bus list is wrong in every window,
// including ones with no session UI mounted.
// Invalidate rather than refetch: this fires in every open window, and a
// window with no session UI would otherwise pay a settings.json read it never
// looks at. The consumers that do read all call `ensureLoaded` first.
void listen(WINDOW_EVENTS.SETTINGS_CHANGED, () => {
  useProfileBusStore.getState().invalidate();
}).catch((error: unknown) => {
  console.error("[profileBusStore] Failed to watch for settings changes:", error);
});

/**
 * A profile's declared bus mappings, shifted onto an output bus range.
 *
 * Empty both before the cache loads and for a profile that declares no buses
 * at all — a GVRET saved before anyone pressed Probe carries only host and
 * port. Empty means "ask the device", not "one bus".
 */
export function profileBusMappings(profileId: string, outputBusOffset = 0): BusMapping[] {
  const declared = useProfileBusStore.getState().mappings.get(profileId);
  return declared ? offsetBusMappings(declared, outputBusOffset) : [];
}

/**
 * The protocols a bus of this profile kind may be set to.
 *
 * Empty before the cache loads and for a kind with nothing to offer; fewer than
 * two entries means the choice is already made and no dropdown is drawn.
 *
 * The imperative read, for callers already inside a `getState()` flow. A React
 * component wants `useKindSupportedProtocols` instead — this one neither loads
 * the cache nor re-renders when it arrives.
 */
export function kindSupportedProtocols(kind: string | undefined): Protocol[] {
  if (!kind) return [];
  return useProfileBusStore.getState().supportedProtocols.get(kind) ?? [];
}

/**
 * The protocols a bus of this profile kind may be set to, as a hook.
 *
 * Loads the cache if no one has yet and re-renders when it lands, so a window
 * that never opens the source picker — Settings, which has its own copy of the
 * per-bus protocol dropdown — still gets an answer. Reading `getState()` from a
 * memo instead silently rendered no dropdown at all.
 */
export function useKindSupportedProtocols(kind: string | undefined): Protocol[] {
  const supported = useProfileBusStore((s) => s.supportedProtocols);
  useEffect(() => {
    void useProfileBusStore.getState().ensureLoaded();
  }, []);
  return (kind && supported.get(kind)) || EMPTY_PROTOCOLS;
}

/** A stable empty array, so the hook's identity doesn't change per render. */
const EMPTY_PROTOCOLS: Protocol[] = [];

type TraitsSource = Pick<ProfileBusState, "traits" | "kinds">;
type ProfileRef = Pick<IOProfile, "id"> & { kind?: string };

function lookupTraits({ traits, kinds }: TraitsSource, profile: ProfileRef): ProfileTraits | undefined {
  return traits.get(profile.id) ?? kinds.find((k) => k.kind === profile.kind);
}

/**
 * A profile's traits, or its kind's for a profile saved since the cache loaded.
 * Undefined before the cache loads and for a kind Rust does not know.
 *
 * The imperative read; a component wants `useProfileTraits`, which re-renders
 * when the table lands.
 */
export function profileTraits(profile: ProfileRef): ProfileTraits | undefined {
  return lookupTraits(useProfileBusStore.getState(), profile);
}

/** `profileTraits`, as a hook that loads the table and re-renders when it lands. */
export function useProfileTraits(): (profile: ProfileRef) => ProfileTraits | undefined {
  const traits = useProfileBusStore((s) => s.traits);
  const kinds = useProfileBusStore((s) => s.kinds);
  useEffect(() => {
    void useProfileBusStore.getState().ensureLoaded();
  }, []);
  return useCallback((profile: ProfileRef) => lookupTraits({ traits, kinds }, profile), [traits, kinds]);
}

/** Every kind this build can open, in kind-picker order. */
export function useAvailableKinds(): KindTraits[] {
  const kinds = useProfileBusStore((s) => s.kinds);
  useEffect(() => {
    void useProfileBusStore.getState().ensureLoaded();
  }, []);
  return useMemo(() => kinds.filter((k) => k.available), [kinds]);
}

export const isRealtime = (traits: ProfileTraits | undefined) => traits?.temporal_mode === "realtime";

export function isRealtimeProfile(profile: ProfileRef): boolean {
  return isRealtime(profileTraits(profile));
}

export function isMultiSourceCapable(profile: ProfileRef): boolean {
  return profileTraits(profile)?.multi_source ?? false;
}

export function isMultiBusProfile(profile: ProfileRef): boolean {
  return profileTraits(profile)?.multi_bus ?? false;
}

/** The protocol a single-bus profile's one bus carries. */
export function busProtocol(profile: ProfileRef | undefined): Protocol {
  return (profile && profileTraits(profile)?.bus_protocol) || "can";
}
