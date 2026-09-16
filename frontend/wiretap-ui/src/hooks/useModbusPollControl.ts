// ui/src/hooks/useModbusPollControl.ts
//
// Turning one source's Modbus polling off and on.
//
// Split out of `useModbusPolling` because two apps want the switch and only one
// wants the rest: the Decoder owns a catalogue-derived poll set and has to
// reconnect when it changes, while Discovery only needs the device to stop
// talking so its sweeps can have it.
//
// The state is read from the session roster, which Rust owns. It used to be
// optimistic React state — "is it polling?" was whatever we last successfully
// asked for — because per-source pause was write-only: the flags lived inside
// the broker's detached merge task and nothing could read them back. Two panels
// on one session each kept their own answer, and a webview reload came back
// claiming a paused device was polling.
//
// Pausing stops requests, not the connection: the socket stays open. That is
// deliberate and it is why a device that serves one Modbus conversation at a
// time still has to be stopped, not merely paused, before a second client can
// reach it.

import { useCallback } from "react";
import { pauseSourcePolling, resumeSourcePolling } from "../api/io";
import { useSessionStore } from "../stores/sessionStore";
import { tlog } from "../api/settings";

export interface UseModbusPollControlOptions {
  /** The session carrying the source, or null when there is none. */
  sessionId: string | null;
  /** The source profile within that session that per-source pause addresses. */
  profileId: string | null;
}

export interface UseModbusPollControlApi {
  /** Whether polling is currently running (false while paused). */
  isPolling: boolean;
  pausePolling: () => void;
  resumePolling: () => void;
}

export function useModbusPollControl({
  sessionId,
  profileId,
}: UseModbusPollControlOptions): UseModbusPollControlApi {
  // A source starts polling, so an unknown session or an unlisted profile reads
  // as polling — the same seed the optimistic version used, now only covering
  // the window before the first reconcile rather than the whole session.
  const isPolling = useSessionStore((s) =>
    !sessionId || !profileId
      ? true
      : !(s.sessions[sessionId]?.pausedSourceProfileIds ?? []).includes(profileId),
  );

  // Rust broadcasts a lifecycle event on pause and resume, so `useSessionRosterSync`
  // re-fetches and every panel on the session follows. Nothing is set here.
  const setPolling = useCallback(
    (polling: boolean) => {
      if (!sessionId || !profileId) return;
      const call = polling ? resumeSourcePolling : pauseSourcePolling;
      call(sessionId, profileId).catch((e: unknown) =>
        tlog.info(`[useModbusPollControl] ${polling ? "Resume" : "Pause"} polling failed: ${e}`),
      );
    },
    [sessionId, profileId],
  );

  return {
    isPolling,
    pausePolling: useCallback(() => setPolling(false), [setPolling]),
    resumePolling: useCallback(() => setPolling(true), [setPolling]),
  };
}
