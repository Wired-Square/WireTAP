// src/apps/session-manager/views/SessionDetailPanel.tsx

import { Play, Pause, Square, Trash2, UserMinus, Plus, X } from "lucide-react";
import { useSessionManagerStore } from "../stores/sessionManagerStore";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import { useSessionStore } from "../../../stores/sessionStore";
import type { ActiveSessionInfo } from "../../../api/io";
import type { IOProfile } from "../../../hooks/useSettings";
import { iconSm } from "../../../styles/spacing";
import { iconButtonHover, iconButtonHoverDanger } from "../../../styles/buttonStyles";
import { tlog } from "../../../api/settings";

interface SessionDetailPanelProps {
  sessions: ActiveSessionInfo[];
  profiles: IOProfile[];
  onStartSession: (sessionId: string) => void;
  onStopSession: (sessionId: string) => void;
  onPauseSession: (sessionId: string) => void;
  onResumeSession: (sessionId: string) => void;
  onDestroySession: (sessionId: string) => void;
  onEvictListener: (sessionId: string, listenerId: string) => void;
  onAddSource: (sessionId: string) => void;
  onRemoveSource: (sessionId: string, profileId: string) => void;
}

export default function SessionDetailPanel({
  sessions,
  profiles,
  onStartSession,
  onStopSession,
  onPauseSession,
  onResumeSession,
  onDestroySession,
  onEvictListener,
  onAddSource,
  onRemoveSource,
}: SessionDetailPanelProps) {
  const selectedNode = useSessionManagerStore((s) => s.selectedNode);
  const setSelectedNode = useSessionManagerStore((s) => s.setSelectedNode);

  if (!selectedNode) {
    return (
      <div className="w-64 border-l border-[color:var(--border-default)] bg-[var(--bg-surface)] p-4">
        <p className="text-sm text-[color:var(--text-muted)]">
          Select a node to view details
        </p>
      </div>
    );
  }

  // Find the relevant data based on node type
  const renderContent = () => {
    if (selectedNode.type === "session") {
      const sessionId = selectedNode.id.replace("session-", "");
      const session = sessions.find((s) => s.sessionId === sessionId);
      if (!session) return <p className="text-sm text-[color:var(--text-muted)]">Session not found</p>;

      return <SessionDetails session={session} profiles={profiles} onStart={onStartSession} onStop={onStopSession} onPause={onPauseSession} onResume={onResumeSession} onDestroy={onDestroySession} onAddSource={onAddSource} />;
    }

    if (selectedNode.type === "source") {
      const profileId = selectedNode.id.replace("source-", "");
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) return <p className="text-sm text-[color:var(--text-muted)]">Profile not found</p>;

      return <SourceDetails profile={profile} sessions={sessions} onRemoveSource={onRemoveSource} />;
    }

    if (selectedNode.type === "listener") {
      return <ListenerDetails nodeId={selectedNode.id} sessions={sessions} onEvict={onEvictListener} />;
    }

    return null;
  };

  return (
    <div className="w-64 h-full min-h-0 border-l border-[color:var(--border-default)] bg-[var(--bg-surface)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[color:var(--border-default)]">
        <span className="text-sm font-medium text-[color:var(--text-primary)] capitalize">
          {selectedNode.type} Details
        </span>
        <button
          onClick={() => setSelectedNode(null)}
          className={`p-1 rounded ${iconButtonHover}`}
        >
          <X className={iconSm} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {renderContent()}
      </div>
    </div>
  );
}

// Session details sub-component
function SessionDetails({
  session,
  profiles,
  onStart,
  onStop,
  onPause,
  onResume,
  onDestroy,
  onAddSource,
}: {
  session: ActiveSessionInfo;
  profiles: IOProfile[];
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDestroy: (id: string) => void;
  onAddSource: (id: string) => void;
}) {
  const isRunning = session.state === "running";
  const isStopped = session.state === "stopped";
  const isPaused = session.state === "paused";
  const canPause = session.capabilities.can_pause;

  return (
    <div className="space-y-4">
      {/* Session ID */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Session ID
        </label>
        <p className="text-sm text-[color:var(--text-primary)] font-mono break-all">
          {session.sessionId}
        </p>
      </div>

      {/* State */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          State
        </label>
        <p className={`text-sm font-medium ${
          isRunning ? "text-green-400" :
          isStopped ? "text-amber-400" :
          isPaused ? "text-blue-400" :
          "text-red-400"
        }`}>
          {session.state}
        </p>
      </div>

      {/* Device Type */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Device Type
        </label>
        <p className="text-sm text-[color:var(--text-primary)]">
          {session.deviceType}
        </p>
      </div>

      {/* Sources */}
      {session.sourceProfileIds.length > 0 && (
        <div>
          <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
            Sources
          </label>
          <div className="mt-1 space-y-0.5">
            {session.sourceProfileIds.map((id) => {
              const profile = profiles.find((p) => p.id === id);
              return (
                <p key={id} className="text-sm text-[color:var(--text-primary)]">
                  {profile?.name ?? id}
                  {profile && <span className="text-[color:var(--text-muted)] ml-1">({profile.kind})</span>}
                </p>
              );
            })}
          </div>
        </div>
      )}

      {/* Listeners */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Listeners
        </label>
        <p className="text-sm text-[color:var(--text-primary)]">
          {session.listenerCount}
        </p>
      </div>

      {/* Decoder — editable dropdown, syncs to all apps sharing the session */}
      <SessionDecoderPicker session={session} />

      {/* Buffer Info */}
      {session.bufferId && (
        <div>
          <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
            Buffer
          </label>
          <p className="text-sm text-[color:var(--text-primary)]">
            {session.bufferFrameCount?.toLocaleString() ?? 0} frames
          </p>
        </div>
      )}

      {/* Streaming */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Streaming
        </label>
        <p className={`text-sm ${session.isStreaming ? "text-green-400" : "text-[color:var(--text-muted)]"}`}>
          {session.isStreaming ? "Yes" : "No"}
        </p>
      </div>

      {/* Capabilities */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Capabilities
        </label>
        <div className="flex flex-wrap gap-1 mt-1">
          {session.capabilities.can_transmit && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-blue-500/20 text-blue-400">
              transmit
            </span>
          )}
          {session.capabilities.can_pause && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-purple-500/20 text-purple-400">
              pause
            </span>
          )}
          {session.capabilities.supports_time_range && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-green-500/20 text-green-400">
              time-range
            </span>
          )}
          {session.capabilities.is_realtime && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-amber-500/20 text-amber-400">
              realtime
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="pt-2 border-t border-[color:var(--border-default)]">
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide mb-2 block">
          Actions
        </label>
        <div className="flex flex-wrap gap-2">
          {isStopped && (
            <button
              onClick={() => onStart(session.sessionId)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHover} text-green-400`}
            >
              <Play className={iconSm} />
              Start
            </button>
          )}
          {isRunning && (
            <button
              onClick={() => onStop(session.sessionId)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHover} text-amber-400`}
            >
              <Square className={iconSm} />
              Stop
            </button>
          )}
          {isRunning && canPause && (
            <button
              onClick={() => onPause(session.sessionId)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHover} text-blue-400`}
            >
              <Pause className={iconSm} />
              Pause
            </button>
          )}
          {isPaused && (
            <button
              onClick={() => onResume(session.sessionId)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHover} text-green-400`}
            >
              <Play className={iconSm} />
              Resume
            </button>
          )}
          {session.deviceType === "multi_source" && (
            <button
              onClick={() => onAddSource(session.sessionId)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHover} text-purple-400`}
            >
              <Plus className={iconSm} />
              Add Source
            </button>
          )}
          <button
            onClick={() => onDestroy(session.sessionId)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHoverDanger}`}
          >
            <Trash2 className={iconSm} />
            Destroy
          </button>
        </div>
      </div>
    </div>
  );
}

// Source (profile) details sub-component
function SourceDetails({ profile, sessions, onRemoveSource }: {
  profile: IOProfile;
  sessions: ActiveSessionInfo[];
  onRemoveSource: (sessionId: string, profileId: string) => void;
}) {
  // Find sessions that use this profile as a source
  const usingSessions = sessions.filter((s) => s.sourceProfileIds.includes(profile.id));

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Profile Name
        </label>
        <p className="text-sm text-[color:var(--text-primary)]">
          {profile.name}
        </p>
      </div>

      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Profile ID
        </label>
        <p className="text-sm text-[color:var(--text-primary)] font-mono break-all">
          {profile.id}
        </p>
      </div>

      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Device Type
        </label>
        <p className="text-sm text-[color:var(--text-primary)]">
          {profile.kind}
        </p>
      </div>

      {/* Preferred Decoder */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Preferred Decoder
        </label>
        <p className={`text-sm ${profile.preferred_catalog ? "text-[color:var(--text-primary)]" : "text-[color:var(--text-muted)]"}`}>
          {profile.preferred_catalog ?? "None"}
        </p>
      </div>

      {/* Actions — remove from session (only if session has more than 1 source) */}
      {usingSessions.some((s) => s.sourceProfileIds.length > 1) && (
        <div className="pt-2 border-t border-[color:var(--border-default)]">
          <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide mb-2 block">
            Actions
          </label>
          {usingSessions.map((s) =>
            s.sourceProfileIds.length > 1 ? (
              <button
                key={s.sessionId}
                onClick={() => onRemoveSource(s.sessionId, profile.id)}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHoverDanger}`}
              >
                <Trash2 className={iconSm} />
                Remove from {s.sessionId}
              </button>
            ) : null
          )}
        </div>
      )}
    </div>
  );
}

// Decoder picker for a session — reads/writes the session-level catalogPath from sessionStore.
// Apps sharing the session will see the change via their cross-app sync effects.
function SessionDecoderPicker({ session }: { session: ActiveSessionInfo }) {
  const catalogs = useSettingsStore((s) => s.catalogs.list);
  const sessionCatalogPath = useSessionStore(
    (s) => s.sessions[session.sessionId]?.catalogPath ?? null
  );

  // Convert full path to filename for dropdown value
  const currentFilename = sessionCatalogPath
    ? catalogs.find((c) => c.path === sessionCatalogPath)?.filename
      ?? sessionCatalogPath.split("/").pop()
      ?? ""
    : "";

  const handleChange = (filename: string) => {
    if (!filename) {
      tlog.debug(`[session-manager] Clearing session decoder for ${session.sessionId}`);
      useSessionStore.getState().setSessionCatalogPath(session.sessionId, null);
      return;
    }
    const catalog = catalogs.find((c) => c.filename === filename);
    const path = catalog?.path ?? filename;
    tlog.debug(`[session-manager] Setting session decoder → ${path}`);
    useSessionStore.getState().setSessionCatalogPath(session.sessionId, path);
  };

  return (
    <div>
      <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
        Decoder
      </label>
      <select
        className="mt-1 w-full px-2 py-1 text-sm rounded border border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-primary)]"
        value={currentFilename}
        onChange={(e) => handleChange(e.target.value)}
      >
        <option value="">None</option>
        {catalogs.map((c) => (
          <option key={c.filename} value={c.filename}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// Listener details sub-component
function ListenerDetails({ nodeId, sessions, onEvict }: { nodeId: string; sessions: ActiveSessionInfo[]; onEvict: (sessionId: string, listenerId: string) => void }) {
  // Parse "listener::${sessionId}::${listenerId}"
  const parts = nodeId.split("::");
  const sessionId = parts[1];
  const listenerId = parts[2];

  const session = sessions.find((s) => s.sessionId === sessionId);
  const listener = session?.listeners.find((l) => l.listener_id === listenerId);

  if (!listener) {
    return <p className="text-sm text-[color:var(--text-muted)]">Listener not found</p>;
  }

  const formatUptime = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
  };

  return (
    <div className="space-y-4">
      {/* Listener ID */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Listener ID
        </label>
        <p className="text-sm text-[color:var(--text-primary)] font-mono">
          {listener.listener_id}
        </p>
      </div>

      {/* Session */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Session
        </label>
        <p className="text-sm text-[color:var(--text-primary)] font-mono break-all">
          {sessionId}
        </p>
      </div>

      {/* Active status */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Status
        </label>
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${listener.is_active ? "bg-green-400" : "bg-gray-500"}`} />
          <p className={`text-sm ${listener.is_active ? "text-green-400" : "text-[color:var(--text-muted)]"}`}>
            {listener.is_active ? "Active" : "Inactive"}
          </p>
        </div>
      </div>

      {/* Registration time */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Registered
        </label>
        <p className="text-sm text-[color:var(--text-primary)]">
          {formatUptime(listener.registered_seconds_ago)}
        </p>
      </div>

      {/* Actions */}
      <div className="pt-2 border-t border-[color:var(--border-default)]">
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide mb-2 block">
          Actions
        </label>
        <button
          onClick={() => onEvict(sessionId, listenerId)}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHoverDanger}`}
        >
          <UserMinus className={iconSm} />
          Remove
        </button>
      </div>
    </div>
  );
}
