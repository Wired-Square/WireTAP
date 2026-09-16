// ui/src/hooks/useModbusPolling.ts
//
// The Modbus poll lifecycle, extracted from the Decoder.
//
// Modbus is the one source whose *content* is decided by the client: a session
// with no poll groups reads nothing at all. That makes its lifecycle unusually
// entangled — the poll set has to exist before the session starts, changing it
// means reconnecting, and the reconnect has to reuse the session id or a
// single-connection device ends up with two rival clients. This hook owns those
// rules.
//
// The switch itself lives in `useModbusPollControl`, which Discovery uses on its
// own: it wants the device to stop talking, not a poll set to manage.
//
// Where the poll groups come from is deliberately the caller's business — the
// Decoder builds them from a catalogue, the IO source picker builds them from an
// address range (`ModbusPollConfig` → `useIOSourcePickerHandlers`) — but the
// Decoder is this hook's only consumer, because it is the only one that has to
// *re*build a poll set after the session has started.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { tlog } from "../api/settings";
import { useModbusPollControl } from "./useModbusPollControl";
import { anyModbusProfile } from "../utils/modbusProfiles";
import type { ModbusPollGroup } from "../api/catalog";
import type { PlaybackSpeed } from "../components/TimeController";

export interface UseModbusPollingOptions {
  sessionId: string | null;
  isStreaming: boolean;
  /** Source profile ids of the live session (empty when not multi-source). */
  ioProfiles: string[];
  /** Single-source fallback when `ioProfiles` is empty. */
  sourceProfileId: string | null;
  /** Serialised poll groups, or null when there are none to apply. */
  pollsJson: string | null;
  playbackSpeed: PlaybackSpeed;
  watchSource: (
    profileIds: string[],
    options: { modbusPollsJson?: string; speed?: PlaybackSpeed; sessionIdOverride?: string }
  ) => Promise<void>;
}

export interface UseModbusPollingApi {
  /** Whether polling is currently running (false while paused). */
  isPolling: boolean;
  /**
   * Whether poll controls should be shown at all. False once we know the
   * running source isn't Modbus, even if Modbus polls are still loaded.
   */
  pollsApplyToSession: boolean;
  /** Whether "start polling" is possible from a stopped state. */
  canStartPolling: boolean;
  /** Registers across all poll groups, for a summary badge. */
  totalRegisters: number;
  /** Poll groups currently applied, parsed. */
  pollGroups: ModbusPollGroup[];
  /** (Re)start the session with the current poll groups. */
  reconnectWithPolls: () => Promise<void>;
  pausePolling: () => void;
  resumePolling: () => void;
}

export function useModbusPolling({
  sessionId,
  isStreaming,
  ioProfiles,
  sourceProfileId,
  pollsJson,
  playbackSpeed,
  watchSource,
}: UseModbusPollingOptions): UseModbusPollingApi {
  // Track the last-used source profile ids so polling can restart after a stop,
  // when the manager has already cleared the live ones.
  const lastProfileIdsRef = useRef<string[]>([]);
  useEffect(() => {
    if (ioProfiles.length > 0) lastProfileIdsRef.current = ioProfiles;
    else if (sourceProfileId) lastProfileIdsRef.current = [sourceProfileId];
  }, [ioProfiles, sourceProfileId]);

  // Read inside callbacks via refs: these change often, and capturing them in
  // the callback's closure would either stale them or churn its identity.
  const pollsJsonRef = useRef(pollsJson);
  pollsJsonRef.current = pollsJson;
  const speedRef = useRef(playbackSpeed);
  speedRef.current = playbackSpeed;

  const resolveProfileIds = useCallback((): string[] => {
    if (ioProfiles.length > 0) return ioProfiles;
    if (sourceProfileId) return [sourceProfileId];
    return lastProfileIdsRef.current;
  }, [ioProfiles, sourceProfileId]);

  // The single source profile that per-source pause/resume addresses.
  const sourceProfileForPolling =
    ioProfiles.length > 0 ? ioProfiles[0] : sourceProfileId ?? lastProfileIdsRef.current[0] ?? null;

  const { isPolling, pausePolling, resumePolling } = useModbusPollControl({
    sessionId,
    profileId: sourceProfileForPolling,
  });

  const pollProfileIds = resolveProfileIds();

  // The Modbus toolbar is driven by the loaded *catalogue*'s protocol, which lags a
  // catalogue swap: switching a Modbus decoder to a CAN source leaves `protocol` on
  // 'modbus' until the new catalogue finishes parsing, so the poll badge and the
  // Pause/Resume/Start controls render over a CAN session and their handlers address
  // a source that has no polls. Suppress them once we know the running source is not
  // Modbus — but only while streaming, so "load a Modbus catalogue, then start a
  // Modbus source" still offers Start polling from a stopped state.
  const targetsModbus = anyModbusProfile(pollProfileIds);
  const pollsApplyToSession = !(isStreaming && !targetsModbus);
  const canStartPolling = pollsJson !== null && targetsModbus;

  const reconnectWithPolls = useCallback(async () => {
    const profileIds = resolveProfileIds();
    if (profileIds.length === 0) return;
    // Re-watching destroys and recreates the session, so a non-Modbus source
    // must never be re-watched just because Modbus polls happen to be loaded.
    // The caller applies this gate too; keep it here so the hook is safe alone.
    const json = pollsJsonRef.current;
    if (!json || !anyModbusProfile(profileIds)) return;
    try {
      // Reuse the current session id so the backend reinitialises THIS modbus
      // session with the poll groups (its "catalog reinitialise" path —
      // create_multi_source_session destroys+recreates the same id) instead of
      // opening a second, competing connection to the device. Without this, a
      // catalogue loaded after the (pollless) session starts spawns a rival
      // session and the device's single connection slot breaks both.
      await watchSource(profileIds, {
        modbusPollsJson: json,
        speed: speedRef.current,
        sessionIdOverride: sessionId ?? undefined,
      });
    } catch (e) {
      tlog.info(`[useModbusPolling] Modbus reconnect failed: ${e}`);
    }
  }, [resolveProfileIds, watchSource, sessionId]);

  // Reconnect when the poll set changes mid-stream (a catalogue swap, or a new
  // discovery range). Only while streaming — otherwise the next start picks the
  // new polls up anyway.
  const prevPollsJsonRef = useRef(pollsJson);
  useEffect(() => {
    const prev = prevPollsJsonRef.current;
    prevPollsJsonRef.current = pollsJson;
    if (!isStreaming || !pollsApplyToSession) return;
    if (pollsJson && pollsJson !== prev) {
      tlog.debug("[useModbusPolling] Poll groups changed while streaming; reconnecting");
      reconnectWithPolls();
    }
  }, [pollsJson, isStreaming, pollsApplyToSession, reconnectWithPolls]);

  const pollGroups = useMemo<ModbusPollGroup[]>(() => {
    if (!pollsJson) return [];
    try {
      return JSON.parse(pollsJson) as ModbusPollGroup[];
    } catch {
      return [];
    }
  }, [pollsJson]);

  const totalRegisters = useMemo(
    () => pollGroups.reduce((sum, pg) => sum + pg.count, 0),
    [pollGroups]
  );

  return {
    isPolling,
    pollsApplyToSession,
    canStartPolling,
    totalRegisters,
    pollGroups,
    reconnectWithPolls,
    pausePolling,
    resumePolling,
  };
}
