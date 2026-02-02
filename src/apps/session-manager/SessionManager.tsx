// src/apps/session-manager/SessionManager.tsx
//
// Visual session manager with Node-RED style interface showing sessions,
// sources, and listeners as interconnected nodes.

import { useCallback, useEffect, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import {
  listActiveSessions,
  startReaderSession,
  stopReaderSession,
  pauseReaderSession,
  resumeReaderSession,
  destroyReaderSession,
  type ActiveSessionInfo,
} from "../../api/io";
import { useSettings } from "../../hooks/useSettings";
import { useSessionManagerStore } from "./stores/sessionManagerStore";
import AppLayout from "../../components/AppLayout";
import SessionTopBar from "./views/SessionTopBar";
import SessionCanvas from "./views/SessionCanvas";
import SessionDetailPanel from "./views/SessionDetailPanel";

export default function SessionManager() {
  const { settings } = useSettings();
  const [sessions, setSessions] = useState<ActiveSessionInfo[]>([]);
  const autoRefresh = useSessionManagerStore((s) => s.autoRefresh);
  const refreshIntervalMs = useSessionManagerStore((s) => s.refreshIntervalMs);
  const setIsRefreshing = useSessionManagerStore((s) => s.setIsRefreshing);

  const profiles = settings?.io_profiles ?? [];

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const activeSessions = await listActiveSessions();
      setSessions(activeSessions);
    } catch (error) {
      console.error("[SessionManager] Failed to fetch sessions:", error);
    } finally {
      setIsRefreshing(false);
    }
  }, [setIsRefreshing]);

  // Initial fetch and auto-refresh
  useEffect(() => {
    fetchSessions();

    if (autoRefresh) {
      const intervalId = setInterval(fetchSessions, refreshIntervalMs);
      return () => clearInterval(intervalId);
    }
  }, [autoRefresh, refreshIntervalMs, fetchSessions]);

  // Session control handlers
  const handleStartSession = useCallback(async (sessionId: string) => {
    try {
      await startReaderSession(sessionId);
      await fetchSessions();
    } catch (error) {
      console.error("[SessionManager] Failed to start session:", error);
    }
  }, [fetchSessions]);

  const handleStopSession = useCallback(async (sessionId: string) => {
    try {
      await stopReaderSession(sessionId);
      await fetchSessions();
    } catch (error) {
      console.error("[SessionManager] Failed to stop session:", error);
    }
  }, [fetchSessions]);

  const handlePauseSession = useCallback(async (sessionId: string) => {
    try {
      await pauseReaderSession(sessionId);
      await fetchSessions();
    } catch (error) {
      console.error("[SessionManager] Failed to pause session:", error);
    }
  }, [fetchSessions]);

  const handleResumeSession = useCallback(async (sessionId: string) => {
    try {
      await resumeReaderSession(sessionId);
      await fetchSessions();
    } catch (error) {
      console.error("[SessionManager] Failed to resume session:", error);
    }
  }, [fetchSessions]);

  const handleDestroySession = useCallback(async (sessionId: string) => {
    try {
      await destroyReaderSession(sessionId);
      await fetchSessions();
    } catch (error) {
      console.error("[SessionManager] Failed to destroy session:", error);
    }
  }, [fetchSessions]);

  return (
    <AppLayout
      topBar={
        <SessionTopBar
          sessionCount={sessions.length}
          onRefresh={fetchSessions}
        />
      }
    >
      <div className="flex h-full">
        {/* Main canvas */}
        <div className="flex-1 h-full">
          <ReactFlowProvider>
            <SessionCanvas sessions={sessions} profiles={profiles} />
          </ReactFlowProvider>
        </div>

        {/* Detail panel */}
        <SessionDetailPanel
          sessions={sessions}
          profiles={profiles}
          onStartSession={handleStartSession}
          onStopSession={handleStopSession}
          onPauseSession={handlePauseSession}
          onResumeSession={handleResumeSession}
          onDestroySession={handleDestroySession}
        />
      </div>
    </AppLayout>
  );
}
