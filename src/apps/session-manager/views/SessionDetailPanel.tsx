// src/apps/session-manager/views/SessionDetailPanel.tsx

import { Play, Pause, Square, Trash2, X } from "lucide-react";
import { useSessionManagerStore } from "../stores/sessionManagerStore";
import type { ActiveSessionInfo } from "../../../api/io";
import type { IOProfile } from "../../../hooks/useSettings";
import { iconSm } from "../../../styles/spacing";
import { iconButtonHover, iconButtonHoverDanger } from "../../../styles/buttonStyles";

interface SessionDetailPanelProps {
  sessions: ActiveSessionInfo[];
  profiles: IOProfile[];
  onStartSession: (sessionId: string) => void;
  onStopSession: (sessionId: string) => void;
  onPauseSession: (sessionId: string) => void;
  onResumeSession: (sessionId: string) => void;
  onDestroySession: (sessionId: string) => void;
}

export default function SessionDetailPanel({
  sessions,
  profiles,
  onStartSession,
  onStopSession,
  onPauseSession,
  onResumeSession,
  onDestroySession,
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

      return <SessionDetails session={session} onStart={onStartSession} onStop={onStopSession} onPause={onPauseSession} onResume={onResumeSession} onDestroy={onDestroySession} />;
    }

    if (selectedNode.type === "source") {
      const profileId = selectedNode.id.replace("source-", "");
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) return <p className="text-sm text-[color:var(--text-muted)]">Profile not found</p>;

      return <SourceDetails profile={profile} />;
    }

    if (selectedNode.type === "listener") {
      return <ListenerDetails nodeId={selectedNode.id} />;
    }

    return null;
  };

  return (
    <div className="w-64 border-l border-[color:var(--border-default)] bg-[var(--bg-surface)] flex flex-col">
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
  onStart,
  onStop,
  onPause,
  onResume,
  onDestroy,
}: {
  session: ActiveSessionInfo;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDestroy: (id: string) => void;
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

      {/* Listeners */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Listeners
        </label>
        <p className="text-sm text-[color:var(--text-primary)]">
          {session.listenerCount}
        </p>
      </div>

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
function SourceDetails({ profile }: { profile: IOProfile }) {
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
    </div>
  );
}

// Listener details sub-component
function ListenerDetails({ nodeId }: { nodeId: string }) {
  const sessionId = nodeId.replace("listeners-", "");

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Session
        </label>
        <p className="text-sm text-[color:var(--text-primary)] font-mono break-all">
          {sessionId}
        </p>
      </div>

      <p className="text-xs text-[color:var(--text-muted)]">
        Individual listener details are not yet available from the backend.
        Future updates will show per-listener information.
      </p>
    </div>
  );
}
