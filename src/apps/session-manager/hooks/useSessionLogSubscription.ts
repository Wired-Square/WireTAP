// src/apps/session-manager/hooks/useSessionLogSubscription.ts
//
// Hook that subscribes to session events and logs them to sessionLogStore.
// Simplified: only logs from Rust events, no startup enumeration.

import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSessionStore } from "../../../stores/sessionStore";
import { useSessionLogStore } from "../stores/sessionLogStore";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import {
  listActiveSessions,
  type StreamEndedPayload,
  type SessionSuspendedPayload,
  type SessionResumingPayload,
  type StateChangePayload,
} from "../../../api/io";

/** Payload for session-lifecycle event from Rust */
interface SessionLifecyclePayload {
  session_id: string;
  event_type: "created" | "destroyed";
  device_type: string | null;
  state: string | null;
  listener_count: number;
  source_profile_ids: string[];
  /** The listener ID that created the session (only for "created") */
  creator_listener_id: string | null;
}

/** Payload for session-reconfigured event */
interface SessionReconfiguredPayload {
  start: string | null;
  end: string | null;
}

/** Payload for joiner-count-changed event */
interface JoinerCountChangedPayload {
  /** New total listener count */
  count: number;
  /** The listener instance ID that triggered the change (if known) */
  listener_id: string | null;
  /** Human-readable app name (e.g., "discovery", "decoder") */
  app_name: string | null;
  /** Whether the listener joined or left ("joined" | "left" | null for sync) */
  change: "joined" | "left" | null;
}

/** Payload for buffer-orphaned event */
interface BufferOrphanedPayload {
  buffer_id: string;
  buffer_name: string;
  buffer_type: string;
  count: number;
}

/** Payload for buffer-created event */
interface BufferCreatedPayload {
  buffer_id: string;
  buffer_name: string;
  buffer_type: string;
}

/** Payload for device-connected event */
interface DeviceConnectedPayload {
  device_type: string;
  address: string;
  bus_number: number | null;
}

/** Payload for device-probe event (global, not session-scoped) */
interface DeviceProbePayload {
  profile_id: string;
  device_type: string;
  address: string;
  success: boolean;
  cached: boolean;
  bus_count: number;
  error: string | null;
}

/**
 * Cache of session ID -> profile name for destroyed session lookup.
 * When a session is destroyed, it's no longer in listActiveSessions(),
 * so we cache the name on creation to use during destruction.
 */
const sessionProfileNameCache = new Map<string, string>();

/**
 * Get profile name from multiSourceConfigs or settings lookup.
 */
async function resolveProfileName(sessionId: string, profileIds: string[]): Promise<string> {
  // First try multiSourceConfigs (for multi-source sessions)
  try {
    const sessions = await listActiveSessions();
    const session = sessions.find((s) => s.sessionId === sessionId);
    const names = session?.multiSourceConfigs?.map((c) => c.displayName).filter(Boolean) ?? [];
    if (names.length > 0) return names.join(", ");
  } catch {
    // Fall through to settings lookup
  }

  // Fall back to settings lookup by profile ID
  const profiles = useSettingsStore.getState().ioProfiles.profiles;
  if (profiles.length > 0 && profileIds.length > 0) {
    const names = profileIds
      .map((id) => profiles.find((p) => p.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    if (names.length > 0) return names.join(", ");
  }

  // Last resort: if sessionId matches a profile ID, use that profile's name
  const matchingProfile = profiles.find((p) => p.id === sessionId);
  if (matchingProfile?.name) return matchingProfile.name;

  return sessionId;
}

/**
 * Get cached profile name for a session, or resolve it if not cached.
 * Use this for destroyed sessions where the session is no longer active.
 */
function getCachedProfileName(sessionId: string, profileIds: string[]): string {
  // Try cache first (for destroyed sessions)
  const cached = sessionProfileNameCache.get(sessionId);
  if (cached) return cached;

  // Fall back to settings lookup by profile ID
  const profiles = useSettingsStore.getState().ioProfiles.profiles;
  if (profiles.length > 0 && profileIds.length > 0) {
    const names = profileIds
      .map((id) => profiles.find((p) => p.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    if (names.length > 0) return names.join(", ");
  }

  // Last resort: if sessionId matches a profile ID, use that profile's name
  const matchingProfile = profiles.find((p) => p.id === sessionId);
  if (matchingProfile?.name) return matchingProfile.name;

  return sessionId;
}

/**
 * Hook that subscribes to session events and logs them.
 */
export function useSessionLogSubscription(): void {
  const perSessionListenersRef = useRef<Map<string, UnlistenFn[]>>(new Map());
  const globalUnlistenRef = useRef<UnlistenFn | null>(null);
  const deviceProbeUnlistenRef = useRef<UnlistenFn | null>(null);
  // Track effect instance to handle React StrictMode double-mount
  const effectInstanceRef = useRef(0);

  // Main effect: set up lifecycle and per-session listeners
  useEffect(() => {
    // Increment instance counter for this effect run
    const thisInstance = ++effectInstanceRef.current;
    const perSessionListeners = perSessionListenersRef.current;

    // Helper to check if this effect instance is still current
    const isCurrentInstance = () => effectInstanceRef.current === thisInstance;

    // Listen to Rust lifecycle events (created/destroyed)
    listen<SessionLifecyclePayload>("session-lifecycle", async (event) => {
      // Skip if this effect instance was superseded (React StrictMode)
      if (!isCurrentInstance()) return;

      const p = event.payload;
      const addEntryFn = useSessionLogStore.getState().addEntry;

      if (p.event_type === "created") {
        const profileName = await resolveProfileName(p.session_id, p.source_profile_ids);
        if (!isCurrentInstance()) return; // Check again after async
        // Cache the profile name for when the session is destroyed
        sessionProfileNameCache.set(p.session_id, profileName);
        // Determine mode based on device type (realtime = Live, timeline = Playback)
        let modeLabel = "";
        if (p.device_type) {
          const realtimeDevices = ["gvret_tcp", "gvret_usb", "slcan", "socketcan", "gs_usb", "mqtt", "modbus_tcp"];
          const isRealtime = realtimeDevices.some((d) => p.device_type?.includes(d));
          modeLabel = isRealtime ? " (Live)" : " (Playback)";
        }
        addEntryFn({
          eventType: "session-created",
          sessionId: p.session_id,
          profileId: p.source_profile_ids[0] ?? null,
          profileName,
          appName: p.creator_listener_id,
          details: `Session created${modeLabel}`,
        });
        // Log the initial listener (this event fires before we can set up the listener)
        if (p.listener_count > 0 && p.creator_listener_id) {
          addEntryFn({
            eventType: "session-joined",
            sessionId: p.session_id,
            profileId: p.source_profile_ids[0] ?? null,
            profileName,
            appName: p.creator_listener_id,
            details: `${p.creator_listener_id} joined (${p.listener_count} listeners)`,
          });
        }
        setupPerSessionListeners(p.session_id, perSessionListeners);
      } else if (p.event_type === "destroyed") {
        // Use cached profile name (session is already destroyed, can't look it up)
        const profileName = getCachedProfileName(p.session_id, p.source_profile_ids);
        // Remove from cache
        sessionProfileNameCache.delete(p.session_id);
        addEntryFn({
          eventType: "session-destroyed",
          sessionId: p.session_id,
          profileId: p.source_profile_ids[0] ?? null,
          profileName,
          appName: null,
          details: "Session destroyed",
        });
        cleanupPerSessionListeners(p.session_id, perSessionListeners);
      }
    }).then((unlisten) => {
      if (isCurrentInstance()) {
        globalUnlistenRef.current = unlisten;
      } else {
        // Effect was superseded, clean up immediately
        unlisten();
      }
    });

    // Listen to device-probe events (global, not session-scoped)
    listen<DeviceProbePayload>("device-probe", (event) => {
      if (!isCurrentInstance()) return;

      const p = event.payload;
      const addEntryFn = useSessionLogStore.getState().addEntry;
      const profiles = useSettingsStore.getState().ioProfiles.profiles;
      // Resolve profile name from settings, or fall back to profile_id
      const matchedProfile = profiles.find((pr) => pr.id === p.profile_id);
      const profileName = matchedProfile?.name ?? null;

      const cachedTag = p.cached ? " (cached)" : "";
      const details = p.success
        ? `${p.device_type} at ${p.address}: ${p.bus_count} bus(es)${cachedTag}`
        : `${p.device_type} at ${p.address}: ${p.error ?? "failed"}${cachedTag}`;

      addEntryFn({
        eventType: "device-probe",
        sessionId: p.profile_id, // Use profile_id as session identifier for probes
        profileId: p.profile_id,
        profileName,
        appName: null,
        details,
      });
    }).then((unlisten) => {
      if (isCurrentInstance()) {
        deviceProbeUnlistenRef.current = unlisten;
      } else {
        unlisten();
      }
    });

    // Set up listeners for any sessions that already exist
    listActiveSessions().then((sessions) => {
      if (!isCurrentInstance()) return;
      for (const session of sessions) {
        setupPerSessionListeners(session.sessionId, perSessionListeners);
      }
    });

    return () => {
      // Cleanup: unlisten and unsubscribe
      // Note: effectInstanceRef is already incremented at this point by the next effect run (in StrictMode)
      // so isCurrentInstance() would return false, but we don't need to check it here
      globalUnlistenRef.current?.();
      globalUnlistenRef.current = null;
      deviceProbeUnlistenRef.current?.();
      deviceProbeUnlistenRef.current = null;
      for (const sessionId of perSessionListeners.keys()) {
        cleanupPerSessionListeners(sessionId, perSessionListeners);
      }
    };
  }, []);

  // Periodic stats logging
  const statsIntervalSeconds = useSettingsStore((s) => s.general.sessionManagerStatsInterval);

  useEffect(() => {
    if (statsIntervalSeconds <= 0) return;

    const collectStats = async () => {
      try {
        const sessions = await listActiveSessions();
        if (sessions.length === 0) return;

        const addEntryFn = useSessionLogStore.getState().addEntry;
        for (const session of sessions) {
          const profileName = await resolveProfileName(session.sessionId, session.sourceProfileIds);
          const parts = [
            `State: ${session.state}`,
            `Listeners: ${session.listenerCount}`,
            `Frames: ${session.bufferFrameCount ?? 0}`,
          ];
          if (session.capabilities?.supports_speed_control) {
            parts.push(`Speed: 1x`); // TODO: add speed to ActiveSessionInfo if needed
          }
          addEntryFn({
            eventType: "session-stats",
            sessionId: session.sessionId,
            profileId: session.sourceProfileIds[0] ?? null,
            profileName,
            appName: null,
            details: parts.join(", "),
          });
        }
      } catch (err) {
        console.error("[SessionLog] Stats collection failed:", err);
      }
    };

    const intervalId = setInterval(collectStats, statsIntervalSeconds * 1000);
    return () => clearInterval(intervalId);
  }, [statsIntervalSeconds]);
}

/**
 * Set up per-session event listeners (stream-ended, errors, etc).
 */
async function setupPerSessionListeners(
  sessionId: string,
  listenersMap: Map<string, UnlistenFn[]>
): Promise<void> {
  // Synchronous guard - add placeholder immediately to prevent race
  if (listenersMap.has(sessionId)) return;
  listenersMap.set(sessionId, []); // Placeholder

  const unlistenFns: UnlistenFn[] = [];
  const addEntry = useSessionLogStore.getState().addEntry;

  // Helper to get profile info asynchronously
  const getProfileInfo = async () => {
    try {
      const sessions = await listActiveSessions();
      const session = sessions.find((s) => s.sessionId === sessionId);
      if (session) {
        const profileName = await resolveProfileName(sessionId, session.sourceProfileIds);
        return { profileId: session.sourceProfileIds[0] ?? null, profileName };
      }
    } catch {
      // Fall through
    }
    // Fallback to sessionStore
    const s = useSessionStore.getState().sessions[sessionId];
    if (s) {
      return { profileId: s.profileId ?? null, profileName: s.profileName ?? sessionId };
    }
    // Last resort: use cache (for when session is being destroyed)
    const cachedName = sessionProfileNameCache.get(sessionId);
    return { profileId: null, profileName: cachedName ?? sessionId };
  };

  try {
    unlistenFns.push(
      await listen<string>(`session-error:${sessionId}`, async (e) => {
        const { profileId, profileName } = await getProfileInfo();
        addEntry({ eventType: "session-error", sessionId, profileId, profileName, appName: null, details: e.payload });
      })
    );

    unlistenFns.push(
      await listen<StreamEndedPayload>(`stream-ended:${sessionId}`, async (e) => {
        const { profileId, profileName } = await getProfileInfo();
        addEntry({
          eventType: "stream-ended",
          sessionId,
          profileId,
          profileName,
          appName: null,
          details: `Reason: ${e.payload.reason}, buffer: ${e.payload.buffer_available ? `${e.payload.count} items` : "none"}`,
        });
      })
    );

    unlistenFns.push(
      await listen<boolean>(`stream-complete:${sessionId}`, async () => {
        const { profileId, profileName } = await getProfileInfo();
        addEntry({ eventType: "stream-complete", sessionId, profileId, profileName, appName: null, details: "Stream completed" });
      })
    );

    unlistenFns.push(
      await listen<number>(`speed-changed:${sessionId}`, async (e) => {
        const { profileId, profileName } = await getProfileInfo();
        addEntry({ eventType: "speed-changed", sessionId, profileId, profileName, appName: null, details: `Speed: ${e.payload}x` });
      })
    );

    // Suspended merged into state-change with buffer info
    unlistenFns.push(
      await listen<SessionSuspendedPayload>(`session-suspended:${sessionId}`, async (e) => {
        const { profileId, profileName } = await getProfileInfo();
        addEntry({ eventType: "state-change", sessionId, profileId, profileName, appName: null, details: `State: running → stopped (buffer finalized: ${e.payload.buffer_count} ${e.payload.buffer_type ?? "items"})` });
      })
    );

    // Resuming merged into state-change with buffer info
    unlistenFns.push(
      await listen<SessionResumingPayload>(`session-resuming:${sessionId}`, async (e) => {
        const { profileId, profileName } = await getProfileInfo();
        addEntry({ eventType: "state-change", sessionId, profileId, profileName, appName: null, details: `State: stopped → running (new buffer: ${e.payload.new_buffer_id}, orphaned: ${e.payload.orphaned_buffer_id})` });
      })
    );

    unlistenFns.push(
      await listen<SessionReconfiguredPayload>(`session-reconfigured:${sessionId}`, async (e) => {
        const { profileId, profileName } = await getProfileInfo();
        addEntry({ eventType: "session-reconfigured", sessionId, profileId, profileName, appName: null, details: `Time range: ${e.payload.start ?? "start"} → ${e.payload.end ?? "end"}` });
      })
    );

    // Buffer events
    unlistenFns.push(
      await listen<BufferOrphanedPayload>(`buffer-orphaned:${sessionId}`, async (e) => {
        const { profileId, profileName } = await getProfileInfo();
        addEntry({ eventType: "buffer-orphaned", sessionId, profileId, profileName, appName: null, details: `Buffer available: ${e.payload.buffer_id} (${e.payload.count} ${e.payload.buffer_type})` });
      })
    );

    unlistenFns.push(
      await listen<BufferCreatedPayload>(`buffer-created:${sessionId}`, async (e) => {
        const { profileId, profileName } = await getProfileInfo();
        addEntry({ eventType: "buffer-created", sessionId, profileId, profileName, appName: null, details: `Buffer: ${e.payload.buffer_id} (${e.payload.buffer_type})` });
      })
    );

    // Device connection events
    unlistenFns.push(
      await listen<DeviceConnectedPayload>(`device-connected:${sessionId}`, async (e) => {
        const { profileId, profileName } = await getProfileInfo();
        const busInfo = e.payload.bus_number !== null ? ` (bus ${e.payload.bus_number})` : "";
        addEntry({ eventType: "device-connected", sessionId, profileId, profileName, appName: null, details: `${e.payload.device_type} connected: ${e.payload.address}${busInfo}` });
      })
    );

    // Track state changes (play/stop/pause)
    unlistenFns.push(
      await listen<StateChangePayload>(`session-state:${sessionId}`, async (e) => {
        const { profileId, profileName } = await getProfileInfo();
        addEntry({
          eventType: "state-change",
          sessionId,
          profileId,
          profileName,
          appName: null,
          details: `State: ${e.payload.previous} → ${e.payload.current}`,
        });
      })
    );

    // Track listener count changes (joins/leaves) - merged into session-joined/session-left
    // Start from 0 so the first joiner-count-changed event (e.g., count=1) is logged as a join
    let prevListenerCount = 0;

    unlistenFns.push(
      await listen<JoinerCountChangedPayload>(`joiner-count-changed:${sessionId}`, async (e) => {
        const { count, listener_id, app_name, change } = e.payload;
        console.log(`[SessionLog:joiner] ${sessionId}: prev=${prevListenerCount} new=${count} listener=${listener_id} app=${app_name} change=${change}`);
        if (count === prevListenerCount) {
          return; // No change
        }
        const { profileId, profileName } = await getProfileInfo();
        const listenerName = app_name ?? listener_id ?? "unknown";
        if (count > prevListenerCount) {
          addEntry({ eventType: "session-joined", sessionId, profileId, profileName, appName: app_name ?? listener_id, details: `${listenerName} joined (${count} listeners)` });
        } else if (count < prevListenerCount) {
          addEntry({ eventType: "session-left", sessionId, profileId, profileName, appName: app_name ?? listener_id, details: `${listenerName} left (${count} listeners)` });
        }
        prevListenerCount = count;
      })
    );

    listenersMap.set(sessionId, unlistenFns);
  } catch (error) {
    console.error(`[SessionLog] Failed to set up listeners for ${sessionId}:`, error);
    for (const fn of unlistenFns) fn();
    listenersMap.delete(sessionId);
  }
}

/**
 * Clean up per-session event listeners.
 */
function cleanupPerSessionListeners(sessionId: string, listenersMap: Map<string, UnlistenFn[]>): void {
  const fns = listenersMap.get(sessionId);
  if (fns) {
    for (const fn of fns) fn();
    listenersMap.delete(sessionId);
  }
}
