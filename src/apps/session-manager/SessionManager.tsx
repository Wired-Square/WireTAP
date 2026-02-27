// src/apps/session-manager/SessionManager.tsx
//
// Visual session manager with Node-RED style interface showing sessions,
// sources, and listeners as interconnected nodes.

import { useCallback, useEffect, useState, useMemo } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import {
  listActiveSessions,
  startReaderSession,
  stopReaderSession,
  pauseReaderSession,
  resumeReaderSession,
  destroyReaderSession,
  evictSessionListener,
  addSourceToSession,
  removeSourceFromSession,
  type ActiveSessionInfo,
} from "../../api/io";
import Dialog from "../../components/Dialog";
import { useSettingsStore } from "../settings/stores/settingsStore";
import { useSessionManagerStore } from "./stores/sessionManagerStore";
import { useSessionLogStore } from "./stores/sessionLogStore";
import { useSessionLogSubscription } from "./hooks/useSessionLogSubscription";
import AppLayout from "../../components/AppLayout";
import AppTabView, { type TabDefinition } from "../../components/AppTabView";
import SessionTopBar from "./views/SessionTopBar";
import SessionCanvas from "./views/SessionCanvas";
import SessionDetailPanel from "./views/SessionDetailPanel";
import SessionLogView from "./views/SessionLogView";

export default function SessionManager() {
  const [sessions, setSessions] = useState<ActiveSessionInfo[]>([]);
  const [activeTab, setActiveTab] = useState<string>("log");
  const autoRefresh = useSessionManagerStore((s) => s.autoRefresh);
  const refreshIntervalMs = useSessionManagerStore((s) => s.refreshIntervalMs);
  const setIsRefreshing = useSessionManagerStore((s) => s.setIsRefreshing);
  const logEntryCount = useSessionLogStore((s) => s.entries.length);

  // Initialise session log subscription
  useSessionLogSubscription();

  // Read profiles from settingsStore (in-memory) so we see preferred_catalog
  // updates immediately, before the debounced save to backend completes.
  const profiles = useSettingsStore((s) => s.ioProfiles.profiles);

  // Tab definitions
  const tabs: TabDefinition[] = useMemo(
    () => [
      {
        id: "log",
        label: "Log",
        count: logEntryCount > 0 ? logEntryCount : undefined,
        countColor: "gray" as const,
      },
      { id: "visual", label: "Visual" },
    ],
    [logEntryCount]
  );

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

  const handleEvictListener = useCallback(async (sessionId: string, listenerId: string) => {
    try {
      await evictSessionListener(sessionId, listenerId);
      await fetchSessions();
    } catch (error) {
      console.error("[SessionManager] Failed to evict listener:", error);
    }
  }, [fetchSessions]);

  // Add Source dialog state
  const [addSourceSessionId, setAddSourceSessionId] = useState<string | null>(null);

  const handleAddSource = useCallback((sessionId: string) => {
    setAddSourceSessionId(sessionId);
  }, []);

  const handleAddSourceConfirm = useCallback(async (profileId: string) => {
    if (!addSourceSessionId) return;
    try {
      await addSourceToSession(addSourceSessionId, {
        profileId,
        busMappings: [],
      });
      setAddSourceSessionId(null);
      await fetchSessions();
    } catch (error) {
      console.error("[SessionManager] Failed to add source:", error);
    }
  }, [addSourceSessionId, fetchSessions]);

  const handleRemoveSource = useCallback(async (sessionId: string, profileId: string) => {
    try {
      await removeSourceFromSession(sessionId, profileId);
      await fetchSessions();
    } catch (error) {
      console.error("[SessionManager] Failed to remove source:", error);
    }
  }, [fetchSessions]);

  // Available profiles for add source dialog (realtime profiles not already in the session)
  const addSourceSession = addSourceSessionId
    ? sessions.find((s) => s.sessionId === addSourceSessionId)
    : null;
  const realtimeKinds = new Set(["gvret_tcp", "gvret_usb", "slcan", "gs_usb", "socketcan", "serial"]);
  const availableProfiles = addSourceSession
    ? profiles.filter(
        (p) =>
          realtimeKinds.has(p.kind) &&
          !addSourceSession.sourceProfileIds.includes(p.id)
      )
    : [];

  return (
    <AppLayout
      topBar={
        <SessionTopBar
          sessionCount={sessions.length}
          onRefresh={fetchSessions}
        />
      }
    >
      <AppTabView
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        protocolLabel="Sessions"
        contentArea={{ wrap: false }}
      >
        {activeTab === "visual" && (
          <div className="flex flex-1 min-h-0">
            {/* Main canvas */}
            <div className="flex-1 min-h-0">
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
              onEvictListener={handleEvictListener}
              onAddSource={handleAddSource}
              onRemoveSource={handleRemoveSource}
            />
          </div>
        )}
        {activeTab === "log" && <SessionLogView />}
      </AppTabView>

      {/* Add Source dialog */}
      <Dialog
        isOpen={addSourceSessionId !== null}
        onBackdropClick={() => setAddSourceSessionId(null)}
        maxWidth="max-w-sm"
      >
        <div className="p-4">
          <h3 className="text-sm font-medium text-[color:var(--text-primary)] mb-3">
            Add Source to Session
          </h3>
          {availableProfiles.length === 0 ? (
            <p className="text-sm text-[color:var(--text-muted)]">
              No available realtime profiles to add.
            </p>
          ) : (
            <div className="space-y-1">
              {availableProfiles.map((profile) => (
                <button
                  key={profile.id}
                  onClick={() => handleAddSourceConfirm(profile.id)}
                  className="w-full text-left px-3 py-2 rounded text-sm text-[color:var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors"
                >
                  <span className="font-medium">{profile.name}</span>
                  <span className="text-[color:var(--text-muted)] ml-2 text-xs">
                    {profile.kind}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => setAddSourceSessionId(null)}
              className="px-3 py-1 rounded text-xs text-[color:var(--text-muted)] hover:bg-[var(--hover-bg)]"
            >
              Cancel
            </button>
          </div>
        </div>
      </Dialog>
    </AppLayout>
  );
}
