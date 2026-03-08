// src/apps/session-manager/views/SessionDetailPanel.tsx

import { useState, useEffect, useCallback, useRef } from "react";
import { Play, Pause, Square, Trash2, UserMinus, Plus, X, Save } from "lucide-react";
import { useSessionManagerStore } from "../stores/sessionManagerStore";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { getTraits, getVirtualBusStates, setVirtualBusTrafficEnabled, setVirtualBusCadence, addVirtualBus, removeVirtualBus, type ActiveSessionInfo, type VirtualBusState, type IOStateType } from "../../../api/io";
import type { IOProfile } from "../../../hooks/useSettings";
import { iconSm } from "../../../styles/spacing";
import { iconButtonHover, iconButtonHoverDanger } from "../../../styles/buttonStyles";
import { emptyStateText } from "../../../styles/typography";
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
  onDisableBusMapping: (sessionId: string, profileId: string, deviceBus: number) => void;
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
  onDisableBusMapping,
}: SessionDetailPanelProps) {
  const selectedNode = useSessionManagerStore((s) => s.selectedNode);
  const setSelectedNode = useSessionManagerStore((s) => s.setSelectedNode);

  if (!selectedNode) {
    return (
      <div className="w-64 border-l border-[color:var(--border-default)] bg-[var(--bg-surface)] p-4">
        <p className={emptyStateText}>
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

      return <SessionDetails session={session} profiles={profiles} onStart={onStartSession} onStop={onStopSession} onPause={onPauseSession} onResume={onResumeSession} onDestroy={onDestroySession} onAddSource={onAddSource} onDisableBusMapping={onDisableBusMapping} />;
    }

    if (selectedNode.type === "source") {
      const profileId = selectedNode.id.replace("source-", "");
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) return <p className="text-sm text-[color:var(--text-muted)]">Profile not found</p>;

      return <SourceDetails profile={profile} sessions={sessions} onRemoveSource={onRemoveSource} onDisableBusMapping={onDisableBusMapping} />;
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

/** Protocol display label (uppercase for acronyms, title-case for others) */
function protocolLabel(protocol: string): string {
  switch (protocol) {
    case "can": return "CAN";
    case "canfd": return "CAN FD";
    case "modbus": return "Modbus";
    case "serial": return "Serial";
    default: return protocol.toUpperCase();
  }
}

/** Protocol badge colour classes */
function protocolBadgeStyle(protocol: string): string {
  switch (protocol) {
    case "can":
    case "canfd":
      return "bg-cyan-500/20 text-cyan-400";
    case "modbus":
      return "bg-teal-500/20 text-teal-400";
    case "serial":
      return "bg-orange-500/20 text-orange-400";
    default:
      return "bg-slate-500/20 text-slate-400";
  }
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
  onDisableBusMapping,
}: {
  session: ActiveSessionInfo;
  profiles: IOProfile[];
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDestroy: (id: string) => void;
  onAddSource: (id: string) => void;
  onDisableBusMapping: (sessionId: string, profileId: string, deviceBus: number) => void;
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
          <div className="mt-1 space-y-1.5">
            {session.sourceProfileIds.map((id) => {
              const profile = profiles.find((p) => p.id === id);
              const config = session.multiSourceConfigs?.find((c) => c.profileId === id);
              const enabledMappings = config?.busMappings.filter((m) => m.enabled) ?? [];
              return (
                <div key={id}>
                  <p className="text-sm text-[color:var(--text-primary)]">
                    {profile?.name ?? id}
                    {profile && <span className="text-[color:var(--text-muted)] ml-1">({profile.kind})</span>}
                  </p>
                  {enabledMappings.length > 0 && (
                    <div className="ml-2 mt-0.5 space-y-0.5">
                      {enabledMappings.map((m) => {
                        // Don't show trash if this is the last enabled mapping on the last source
                        const totalEnabledAcrossSources = session.multiSourceConfigs?.reduce(
                          (sum, c) => sum + (c.busMappings.filter((b) => b.enabled).length), 0
                        ) ?? 0;
                        const canDisable = totalEnabledAcrossSources > 1;
                        return (
                          <div key={`${m.deviceBus}-${m.outputBus}`} className="flex items-center gap-1 text-xs text-[color:var(--text-muted)] font-mono">
                            <span>bus{m.deviceBus} → bus{m.outputBus}</span>
                            {canDisable && (
                              <button
                                onClick={() => onDisableBusMapping(session.sessionId, id, m.deviceBus)}
                                className={`p-0.5 rounded ${iconButtonHoverDanger}`}
                                title={`Remove bus${m.deviceBus} mapping`}
                              >
                                <Trash2 size={10} />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
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
          {getTraits(session.capabilities).protocols.map((protocol) => (
            <span key={protocol} className={`px-1.5 py-0.5 text-xs rounded ${protocolBadgeStyle(protocol)}`}>
              {protocolLabel(protocol)}
            </span>
          ))}
          {session.capabilities.is_realtime && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-amber-500/20 text-amber-400">
              realtime
            </span>
          )}
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
function SourceDetails({ profile, sessions, onRemoveSource, onDisableBusMapping }: {
  profile: IOProfile;
  sessions: ActiveSessionInfo[];
  onRemoveSource: (sessionId: string, profileId: string) => void;
  onDisableBusMapping: (sessionId: string, profileId: string, deviceBus: number) => void;
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

      {/* Bus Mappings */}
      {usingSessions.length > 0 && usingSessions.some((s) => {
        const config = s.multiSourceConfigs?.find((c) => c.profileId === profile.id);
        return config?.busMappings.some((m) => m.enabled);
      }) && (
        <div>
          <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
            Bus Mappings
          </label>
          {usingSessions.map((s) => {
            const config = s.multiSourceConfigs?.find((c) => c.profileId === profile.id);
            const enabledMappings = config?.busMappings.filter((m) => m.enabled) ?? [];
            if (enabledMappings.length === 0) return null;
            return (
              <div key={s.sessionId} className="mt-1">
                {usingSessions.length > 1 && (
                  <p className="text-xs text-[color:var(--text-muted)] font-mono">{s.sessionId}</p>
                )}
                <div className="ml-2 space-y-0.5">
                  {enabledMappings.map((m) => {
                    const totalEnabled = s.multiSourceConfigs?.reduce(
                      (sum, c) => sum + (c.busMappings.filter((b) => b.enabled).length), 0
                    ) ?? 0;
                    const canDisable = totalEnabled > 1;
                    return (
                      <div key={`${m.deviceBus}-${m.outputBus}`} className="flex items-center gap-1 text-xs text-[color:var(--text-primary)] font-mono">
                        <span>bus{m.deviceBus} → bus{m.outputBus}</span>
                        {canDisable && (
                          <button
                            onClick={() => onDisableBusMapping(s.sessionId, profile.id, m.deviceBus)}
                            className={`p-0.5 rounded ${iconButtonHoverDanger}`}
                            title={`Remove bus${m.deviceBus} mapping`}
                          >
                            <Trash2 size={10} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Signal Generator controls (virtual devices only) */}
      {profile.kind === "virtual" && usingSessions.length > 0 && (
        <VirtualSignalGenControls
          profile={profile}
          sessionId={usingSessions[0].sessionId}
          sessionState={usingSessions[0].state}
        />
      )}

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

// Signal generator runtime controls for virtual device sources
function VirtualSignalGenControls({ profile, sessionId, sessionState }: { profile: IOProfile; sessionId: string; sessionState: IOStateType }) {
  const [busStates, setBusStates] = useState<VirtualBusState[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  // Track which buses exist in the running backend (for live toggle/cadence)
  const runtimeBuses = useRef<Set<number>>(new Set());
  const cadenceTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const updateProfile = useSettingsStore((s) => s.updateProfile);

  // Load bus states when session is running
  useEffect(() => {
    if (sessionState !== "running") {
      setBusStates([]);
      setLoading(false);
      setDirty(false);
      runtimeBuses.current.clear();
      return;
    }
    setLoading(true);
    getVirtualBusStates(sessionId)
      .then((states) => {
        setBusStates(states);
        runtimeBuses.current = new Set(states.map((s) => s.bus));
        setDirty(false);
      })
      .catch(() => setBusStates([]))
      .finally(() => setLoading(false));
  }, [sessionId, sessionState]);

  const handleToggle = useCallback(async (bus: number, enabled: boolean) => {
    setBusStates((prev) => prev.map((s) => s.bus === bus ? { ...s, enabled } : s));
    setDirty(true);
    // Only send to backend if bus exists at runtime
    if (!runtimeBuses.current.has(bus)) return;
    try {
      await setVirtualBusTrafficEnabled(sessionId, bus, enabled);
    } catch (e) {
      tlog.debug(`[session-manager] Failed to toggle bus ${bus}: ${e}`);
      setBusStates((prev) => prev.map((s) => s.bus === bus ? { ...s, enabled: !enabled } : s));
    }
  }, [sessionId]);

  const handleCadenceChange = useCallback((bus: number, value: string) => {
    const hz = parseFloat(value);
    if (isNaN(hz)) return;
    setBusStates((prev) => prev.map((s) => s.bus === bus ? { ...s, frame_rate_hz: hz } : s));
    setDirty(true);
    // Only send to backend if bus exists at runtime
    if (!runtimeBuses.current.has(bus)) return;
    if (cadenceTimers.current[bus]) clearTimeout(cadenceTimers.current[bus]);
    cadenceTimers.current[bus] = setTimeout(async () => {
      try {
        await setVirtualBusCadence(sessionId, bus, hz);
      } catch (e) {
        tlog.debug(`[session-manager] Failed to set cadence for bus ${bus}: ${e}`);
      }
    }, 300);
  }, [sessionId]);

  const handleAddBus = useCallback(async () => {
    const usedBuses = new Set(busStates.map((s) => s.bus));
    let nextBus = 0;
    while (usedBuses.has(nextBus) && nextBus < 8) nextBus++;
    if (nextBus >= 8) return;
    const newBus: VirtualBusState = { bus: nextBus, enabled: true, frame_rate_hz: 10 };
    setBusStates((prev) => [...prev, newBus]);
    setDirty(true);
    // Hot-add to running session
    if (runtimeBuses.current.size > 0) {
      try {
        const trafficType = (profile.connection as Record<string, unknown>)?.traffic_type as string || "can";
        await addVirtualBus(sessionId, nextBus, trafficType, 10);
        runtimeBuses.current.add(nextBus);
      } catch (e) {
        tlog.debug(`[session-manager] Failed to hot-add bus ${nextBus}: ${e}`);
      }
    }
  }, [busStates, sessionId, profile]);

  const handleRemoveBus = useCallback(async (bus: number) => {
    setBusStates((prev) => prev.filter((s) => s.bus !== bus));
    setDirty(true);
    // Hot-remove from running session
    if (runtimeBuses.current.has(bus)) {
      try {
        await removeVirtualBus(sessionId, bus);
        runtimeBuses.current.delete(bus);
      } catch (e) {
        tlog.debug(`[session-manager] Failed to hot-remove bus ${bus}: ${e}`);
      }
    }
  }, [sessionId]);

  const handleSaveToProfile = useCallback(() => {
    const interfaces = busStates.map((bs) => ({
      bus: bs.bus,
      signal_generator: bs.enabled,
      frame_rate_hz: bs.frame_rate_hz,
    }));
    const updated: IOProfile = {
      ...profile,
      connection: { ...profile.connection, interfaces },
    };
    updateProfile(profile.id, updated);
    setDirty(false);
    tlog.debug(`[session-manager] Saved signal generator settings to profile ${profile.id}`);
  }, [busStates, profile, updateProfile]);

  if (sessionState !== "running") return null;
  if (loading) return null;
  if (busStates.length === 0) return null;

  return (
    <div className="pt-2 border-t border-[color:var(--border-default)]">
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          Signal Generator
        </label>
        {busStates.length < 8 && (
          <button
            onClick={handleAddBus}
            className={`flex items-center gap-0.5 px-1 py-0.5 rounded text-xs ${iconButtonHover}`}
            title="Add bus"
          >
            <Plus className={iconSm} />
          </button>
        )}
      </div>
      <div className="space-y-2">
        {busStates.map((bs) => (
          <div key={bs.bus} className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 shrink-0">
              <input
                type="checkbox"
                checked={bs.enabled}
                onChange={(e) => handleToggle(bs.bus, e.target.checked)}
                className="w-3.5 h-3.5 text-blue-600 bg-[var(--bg-primary)] border-[color:var(--border-default)] rounded focus:ring-blue-500"
              />
              <span className="text-xs text-[color:var(--text-primary)] w-10">Bus {bs.bus}</span>
            </label>
            <input
              type="number"
              min="1"
              max="1000"
              step="1"
              value={bs.frame_rate_hz}
              onChange={(e) => handleCadenceChange(bs.bus, e.target.value)}
              disabled={!bs.enabled}
              className="w-16 px-1.5 py-0.5 text-xs rounded border border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-primary)] disabled:opacity-40"
            />
            <span className="text-xs text-[color:var(--text-muted)]">Hz</span>
            {busStates.length > 1 && (
              <button
                onClick={() => handleRemoveBus(bs.bus)}
                className={`p-0.5 rounded ${iconButtonHoverDanger}`}
                title={`Remove bus ${bs.bus}`}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
      {dirty && (
        <button
          onClick={handleSaveToProfile}
          className={`mt-2 flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHover}`}
        >
          <Save className={iconSm} />
          Save to Profile
        </button>
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
