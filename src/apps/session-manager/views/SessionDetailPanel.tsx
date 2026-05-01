// src/apps/session-manager/views/SessionDetailPanel.tsx

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Play, Pause, Square, Trash2, UserMinus, Plus, X, Save, Unplug, Plug } from "lucide-react";
import { useSessionManagerStore } from "../stores/sessionManagerStore";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import { useSessionStore } from "../../../stores/sessionStore";
import { getVirtualBusStates, setVirtualBusTrafficEnabled, setVirtualBusCadence, addVirtualBus, removeVirtualBus, type ActiveSessionInfo, type VirtualBusState, type IOStateType } from "../../../api/io";
import type { IOProfile } from "../../../hooks/useSettings";
import { iconSm } from "../../../styles/spacing";
import { iconButtonHover, iconButtonHoverDanger } from "../../../styles/buttonStyles";
import { emptyStateText } from "../../../styles/typography";
import { tlog } from "../../../api/settings";

interface SessionDetailPanelProps {
  sessions: ActiveSessionInfo[];
  profiles: IOProfile[];
  openPanelIds?: string[];
  onStartSession: (sessionId: string) => void;
  onStopSession: (sessionId: string) => void;
  onPauseSession: (sessionId: string) => void;
  onResumeSession: (sessionId: string) => void;
  onDestroySession: (sessionId: string) => void;
  onEvictSubscriber: (sessionId: string, subscriberId: string) => void;
  onAddSource: (sessionId: string) => void;
  onRemoveSource: (sessionId: string, profileId: string) => void;
  onDisableBusMapping: (sessionId: string, profileId: string, deviceBus: number) => void;
  onConnectAppToSession?: (sessionId: string, appName: string) => void;
}

export default function SessionDetailPanel({
  sessions,
  profiles,
  openPanelIds,
  onStartSession,
  onStopSession,
  onPauseSession,
  onResumeSession,
  onDestroySession,
  onEvictSubscriber,
  onAddSource,
  onRemoveSource,
  onDisableBusMapping,
  onConnectAppToSession,
}: SessionDetailPanelProps) {
  const { t } = useTranslation("sessionManager");
  const selectedNode = useSessionManagerStore((s) => s.selectedNode);
  const setSelectedNode = useSessionManagerStore((s) => s.setSelectedNode);

  if (!selectedNode) {
    return (
      <div className="w-64 border-l border-[color:var(--border-default)] bg-[var(--bg-surface)] p-4">
        <p className={emptyStateText}>
          {t("detail.emptyPrompt")}
        </p>
      </div>
    );
  }

  // Find the relevant data based on node type
  const renderContent = () => {
    if (selectedNode.type === "session") {
      const sessionId = selectedNode.id.replace("session-", "");
      const session = sessions.find((s) => s.sessionId === sessionId);
      if (!session) return <p className="text-sm text-[color:var(--text-muted)]">{t("detail.sessionNotFound")}</p>;

      return <SessionDetails session={session} profiles={profiles} openPanelIds={openPanelIds} onStart={onStartSession} onStop={onStopSession} onPause={onPauseSession} onResume={onResumeSession} onDestroy={onDestroySession} onAddSource={onAddSource} onDisableBusMapping={onDisableBusMapping} onConnectApp={onConnectAppToSession} />;
    }

    if (selectedNode.type === "source") {
      const profileId = selectedNode.id.replace("source-", "");
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) return <p className="text-sm text-[color:var(--text-muted)]">{t("detail.profileNotFound")}</p>;

      return <SourceDetails profile={profile} sessions={sessions} onRemoveSource={onRemoveSource} onDisableBusMapping={onDisableBusMapping} />;
    }

    if (selectedNode.type === "app") {
      // Check if this is an unconnected app node (app::panelId — no session ID in the middle)
      const parts = selectedNode.id.split("::");
      if (parts.length === 2) {
        const appName = parts[1];
        return <UnconnectedAppDetails appName={appName} sessions={sessions} onConnectApp={onConnectAppToSession} />;
      }
      return <AppDetails nodeId={selectedNode.id} sessions={sessions} onEvict={onEvictSubscriber} />;
    }

    if (selectedNode.type === "edge") {
      return <EdgeDetails edgeId={selectedNode.id} sessions={sessions} profiles={profiles} onDisableBusMapping={onDisableBusMapping} onEvictSubscriber={onEvictSubscriber} />;
    }

    return null;
  };

  return (
    <div className="w-64 h-full min-h-0 border-l border-[color:var(--border-default)] bg-[var(--bg-surface)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[color:var(--border-default)]">
        <span className="text-sm font-medium text-[color:var(--text-primary)] capitalize">
          {selectedNode.type === "edge" ? t("detail.connectionHeader") : selectedNode.type} {t("detail.headerSuffix")}
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
  openPanelIds,
  onStart,
  onStop,
  onPause,
  onResume,
  onDestroy,
  onAddSource,
  onDisableBusMapping,
  onConnectApp,
}: {
  session: ActiveSessionInfo;
  profiles: IOProfile[];
  openPanelIds?: string[];
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDestroy: (id: string) => void;
  onAddSource: (id: string) => void;
  onDisableBusMapping: (sessionId: string, profileId: string, deviceBus: number) => void;
  onConnectApp?: (sessionId: string, appName: string) => void;
}) {
  const { t } = useTranslation("sessionManager");
  const isRunning = session.state === "running";
  const isStopped = session.state === "stopped";
  const isPaused = session.state === "paused";
  const canPause = session.capabilities.can_pause;

  return (
    <div className="space-y-4">
      {/* Session ID */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.sessionId")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)] font-mono break-all">
          {session.sessionId}
        </p>
      </div>

      {/* State */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.state")}
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
          {t("detail.labels.deviceType")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)]">
          {session.sourceType}
        </p>
      </div>

      {/* Sources */}
      {session.sourceProfileIds.length > 0 && (
        <div>
          <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
            {t("detail.labels.sources")}
          </label>
          <div className="mt-1 space-y-1.5">
            {session.sourceProfileIds.map((id) => {
              const profile = profiles.find((p) => p.id === id);
              const config = session.brokerConfigs?.find((c) => c.profileId === id);
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
                        const totalEnabledAcrossSources = session.brokerConfigs?.reduce(
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
                                title={t("detail.signalGen.removeMapping", { bus: m.deviceBus })}
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

      {/* Apps */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.apps")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)]">
          {session.subscriberCount}
        </p>
      </div>

      {/* Decoder — editable dropdown, syncs to all apps sharing the session */}
      <SessionDecoderPicker session={session} />

      {/* Buffer Info */}
      {session.captureId && (
        <div>
          <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
            {t("detail.labels.buffer")}
          </label>
          <p className="text-sm text-[color:var(--text-primary)]">
            {t("detail.values.framesCount", { count: session.captureFrameCount ?? 0 })}
          </p>
        </div>
      )}

      {/* Streaming */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.streaming")}
        </label>
        <p className={`text-sm ${session.isStreaming ? "text-green-400" : "text-[color:var(--text-muted)]"}`}>
          {session.isStreaming ? t("detail.values.yes") : t("detail.values.no")}
        </p>
      </div>

      {/* Capabilities */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.capabilities")}
        </label>
        <div className="flex flex-wrap gap-1 mt-1">
          {session.capabilities.traits.protocols.map((protocol) => (
            <span key={protocol} className={`px-1.5 py-0.5 text-xs rounded ${protocolBadgeStyle(protocol)}`}>
              {protocolLabel(protocol)}
            </span>
          ))}
          {session.capabilities.traits.temporal_mode === "realtime" && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-amber-500/20 text-amber-400">
              {t("detail.values.realtime")}
            </span>
          )}
          {session.capabilities.traits.tx_frames && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-blue-500/20 text-blue-400">
              {t("detail.values.transmit")}
            </span>
          )}
          {session.capabilities.can_pause && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-purple-500/20 text-purple-400">
              {t("detail.values.pause")}
            </span>
          )}
          {session.capabilities.supports_time_range && (
            <span className="px-1.5 py-0.5 text-xs rounded bg-green-500/20 text-green-400">
              {t("detail.values.timeRange")}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="pt-2 border-t border-[color:var(--border-default)]">
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide mb-2 block">
          {t("detail.labels.actions")}
        </label>
        <div className="flex flex-wrap gap-2">
          {isStopped && (
            <button
              onClick={() => onStart(session.sessionId)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHover} text-green-400`}
            >
              <Play className={iconSm} />
              {t("detail.actions.start")}
            </button>
          )}
          {isRunning && (
            <button
              onClick={() => onStop(session.sessionId)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHover} text-amber-400`}
            >
              <Square className={iconSm} />
              {t("detail.actions.stop")}
            </button>
          )}
          {isRunning && canPause && (
            <button
              onClick={() => onPause(session.sessionId)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHover} text-blue-400`}
            >
              <Pause className={iconSm} />
              {t("detail.actions.pause")}
            </button>
          )}
          {isPaused && (
            <button
              onClick={() => onResume(session.sessionId)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHover} text-green-400`}
            >
              <Play className={iconSm} />
              {t("detail.actions.resume")}
            </button>
          )}
          {session.sourceType === "realtime" && (
            <button
              onClick={() => onAddSource(session.sessionId)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHover} text-purple-400`}
            >
              <Plus className={iconSm} />
              {t("detail.actions.addSource")}
            </button>
          )}
          <button
            onClick={() => onDestroy(session.sessionId)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHoverDanger}`}
          >
            <Trash2 className={iconSm} />
            {t("detail.actions.destroy")}
          </button>
        </div>
      </div>

      {/* Connect unconnected apps */}
      {onConnectApp && openPanelIds && (() => {
        const connectedApps = new Set(session.subscribers.map((l) => (l.app_name || l.subscriber_id).toLowerCase()));
        const SESSION_AWARE = ["discovery", "decoder", "transmit", "query", "graph"];
        const unconnected = openPanelIds.filter(
          (id) => SESSION_AWARE.includes(id) && !connectedApps.has(id)
        );
        if (unconnected.length === 0) return null;
        return (
          <div className="pt-2 border-t border-[color:var(--border-default)]">
            <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide mb-2 block">
              {t("detail.labels.connectApp")}
            </label>
            <div className="space-y-1">
              {unconnected.map((appName) => (
                <button
                  key={appName}
                  onClick={() => onConnectApp(session.sessionId, appName)}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHover} text-cyan-400 capitalize`}
                >
                  <Plug className={iconSm} />
                  {appName}
                </button>
              ))}
            </div>
          </div>
        );
      })()}
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
  const { t } = useTranslation("sessionManager");
  // Find sessions that use this profile as a source
  const usingSessions = sessions.filter((s) => s.sourceProfileIds.includes(profile.id));

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.profileName")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)]">
          {profile.name}
        </p>
      </div>

      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.profileId")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)] font-mono break-all">
          {profile.id}
        </p>
      </div>

      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.deviceType")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)]">
          {profile.kind}
        </p>
      </div>

      {/* Preferred Decoder */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.preferredDecoder")}
        </label>
        <p className={`text-sm ${profile.preferred_catalog ? "text-[color:var(--text-primary)]" : "text-[color:var(--text-muted)]"}`}>
          {profile.preferred_catalog ?? t("detail.values.none")}
        </p>
      </div>

      {/* Bus Mappings */}
      {usingSessions.length > 0 && usingSessions.some((s) => {
        const config = s.brokerConfigs?.find((c) => c.profileId === profile.id);
        return config?.busMappings.some((m) => m.enabled);
      }) && (
        <div>
          <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
            {t("detail.labels.busMappings")}
          </label>
          {usingSessions.map((s) => {
            const config = s.brokerConfigs?.find((c) => c.profileId === profile.id);
            const enabledMappings = config?.busMappings.filter((m) => m.enabled) ?? [];
            if (enabledMappings.length === 0) return null;
            return (
              <div key={s.sessionId} className="mt-1">
                {usingSessions.length > 1 && (
                  <p className="text-xs text-[color:var(--text-muted)] font-mono">{s.sessionId}</p>
                )}
                <div className="ml-2 space-y-0.5">
                  {enabledMappings.map((m) => {
                    const totalEnabled = s.brokerConfigs?.reduce(
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
                            title={t("detail.signalGen.removeMapping", { bus: m.deviceBus })}
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
            {t("detail.labels.actions")}
          </label>
          {usingSessions.map((s) =>
            s.sourceProfileIds.length > 1 ? (
              <button
                key={s.sessionId}
                onClick={() => onRemoveSource(s.sessionId, profile.id)}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHoverDanger}`}
              >
                <Trash2 className={iconSm} />
                {t("detail.actions.removeFrom", { sessionId: s.sessionId })}
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
  const { t } = useTranslation("sessionManager");
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
    const updated = {
      ...profile,
      connection: { ...profile.connection, interfaces },
    } as IOProfile;
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
          {t("detail.labels.signalGenerator")}
        </label>
        {busStates.length < 8 && (
          <button
            onClick={handleAddBus}
            className={`flex items-center gap-0.5 px-1 py-0.5 rounded text-xs ${iconButtonHover}`}
            title={t("detail.signalGen.addBus")}
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
                className="w-3.5 h-3.5 rounded border-[color:var(--border-default)] text-[color:var(--accent-primary)] focus:ring-[color:var(--accent-primary)]"
              />
              <span className="text-xs text-[color:var(--text-primary)] w-10">{t("detail.signalGen.busLabel", { bus: bs.bus })}</span>
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
            <span className="text-xs text-[color:var(--text-muted)]">{t("detail.signalGen.hz")}</span>
            {busStates.length > 1 && (
              <button
                onClick={() => handleRemoveBus(bs.bus)}
                className={`p-0.5 rounded ${iconButtonHoverDanger}`}
                title={t("detail.signalGen.removeBus", { bus: bs.bus })}
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
          {t("detail.actions.saveToProfile")}
        </button>
      )}
    </div>
  );
}

// Decoder picker for a session — reads/writes the session-level catalogPath from sessionStore.
// Apps sharing the session will see the change via their cross-app sync effects.
function SessionDecoderPicker({ session }: { session: ActiveSessionInfo }) {
  const { t } = useTranslation("sessionManager");
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
        {t("detail.labels.decoder")}
      </label>
      <select
        className="mt-1 w-full px-2 py-1 text-sm rounded border border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-primary)]"
        value={currentFilename}
        onChange={(e) => handleChange(e.target.value)}
      >
        <option value="">{t("detail.values.none")}</option>
        {catalogs.map((c) => (
          <option key={c.filename} value={c.filename}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// Unconnected app details sub-component
function UnconnectedAppDetails({
  appName,
  sessions,
  onConnectApp,
}: {
  appName: string;
  sessions: ActiveSessionInfo[];
  onConnectApp?: (sessionId: string, appName: string) => void;
}) {
  const { t } = useTranslation("sessionManager");
  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.app")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)] capitalize">
          {appName}
        </p>
      </div>

      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.status")}
        </label>
        <p className="text-sm text-[color:var(--text-muted)]">
          {t("detail.values.notConnected")}
        </p>
      </div>

      {/* Connect to session */}
      {onConnectApp && sessions.length > 0 && (
        <div className="pt-2 border-t border-[color:var(--border-default)]">
          <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide mb-2 block">
            {t("detail.labels.connectToSession")}
          </label>
          <div className="space-y-1">
            {sessions.map((s) => (
              <button
                key={s.sessionId}
                onClick={() => onConnectApp(s.sessionId, appName)}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHover} text-cyan-400`}
              >
                <Plug className={iconSm} />
                <span className="font-mono truncate">{s.sessionId}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Edge (connection) details sub-component
function EdgeDetails({
  edgeId,
  sessions,
  profiles,
  onDisableBusMapping,
  onEvictSubscriber,
}: {
  edgeId: string;
  sessions: ActiveSessionInfo[];
  profiles: IOProfile[];
  onDisableBusMapping: (sessionId: string, profileId: string, deviceBus: number) => void;
  onEvictSubscriber: (sessionId: string, subscriberId: string) => void;
}) {
  const { t } = useTranslation("sessionManager");
  // Parse edge ID to determine type
  // Source→Session: "edge-{profileId}-{sessionId}-b{deviceBus}-b{outputBus}"
  // Session→Listener: "edge-{sessionId}::{subscriberId}"

  if (edgeId.includes("::")) {
    // Session → Listener edge
    const match = edgeId.match(/^edge-(.+?)::(.+)$/);
    if (!match) return <p className="text-sm text-[color:var(--text-muted)]">{t("detail.edgeNotFound")}</p>;
    const [, sessionId, subscriberId] = match;
    const session = sessions.find((s) => s.sessionId === sessionId);
    const listener = session?.subscribers.find((l) => l.subscriber_id === subscriberId);

    return (
      <div className="space-y-4">
        <div>
          <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
            {t("detail.labels.type")}
          </label>
          <p className="text-sm text-[color:var(--text-primary)]">
            {t("detail.values.sessionToApp")}
          </p>
        </div>

        <div>
          <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
            {t("detail.labels.session")}
          </label>
          <p className="text-sm text-[color:var(--text-primary)] font-mono break-all">
            {sessionId}
          </p>
        </div>

        <div>
          <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
            {t("detail.labels.app")}
          </label>
          <p className="text-sm text-[color:var(--text-primary)] font-mono">
            {subscriberId}
          </p>
          {listener && (
            <p className="text-xs text-[color:var(--text-muted)] capitalize">
              {listener.app_name || subscriberId}
            </p>
          )}
        </div>

        <div className="pt-2 border-t border-[color:var(--border-default)]">
          <button
            onClick={() => onEvictSubscriber(sessionId, subscriberId)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHoverDanger}`}
          >
            <Unplug className={iconSm} />
            {t("detail.actions.disconnect")}
          </button>
        </div>
      </div>
    );
  }

  // Source → Session edge: "edge-{profileId}-{sessionId}-b{deviceBus}-b{outputBus}"
  // Both profileId and sessionId may contain hyphens, so parse from the suffix.
  const busSuffix = edgeId.match(/-b(\d+)-b(\d+)$/);
  if (!busSuffix) {
    return (
      <div className="space-y-4">
        <div>
          <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
            {t("detail.labels.type")}
          </label>
          <p className="text-sm text-[color:var(--text-primary)]">
            {t("detail.values.deviceToSession")}
          </p>
        </div>
      </div>
    );
  }

  const deviceBusStr = busSuffix[1];
  const outputBusStr = busSuffix[2];
  // Strip "edge-" prefix and "-bN-bN" suffix to get "{profileId}-{sessionId}"
  const middle = edgeId.slice(5, edgeId.length - busSuffix[0].length);
  // Find matching profile+session by trying known session IDs
  let profileId = "";
  let sessionId = "";
  for (const s of sessions) {
    if (middle.endsWith(`-${s.sessionId}`)) {
      sessionId = s.sessionId;
      profileId = middle.slice(0, middle.length - s.sessionId.length - 1);
      break;
    }
  }
  const deviceBus = parseInt(deviceBusStr, 10);
  const outputBus = parseInt(outputBusStr, 10);
  const profile = profiles.find((p) => p.id === profileId);
  const session = sessions.find((s) => s.sessionId === sessionId);

  // Can we disable this mapping? Only if it's not the last enabled mapping
  const totalEnabled = session?.brokerConfigs?.reduce(
    (sum, c) => sum + (c.busMappings.filter((b) => b.enabled).length), 0
  ) ?? 0;
  const canDisable = totalEnabled > 1;

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.type")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)]">
          {t("detail.values.deviceToSession")}
        </p>
      </div>

      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.device")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)]">
          {profile?.name ?? profileId}
        </p>
      </div>

      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.busMapping")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)] font-mono">
          bus{deviceBus} → bus{outputBus}
        </p>
      </div>

      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.session")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)] font-mono break-all">
          {sessionId}
        </p>
      </div>

      {canDisable && (
        <div className="pt-2 border-t border-[color:var(--border-default)]">
          <button
            onClick={() => onDisableBusMapping(sessionId, profileId, deviceBus)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHoverDanger}`}
          >
            <Unplug className={iconSm} />
            {t("detail.actions.disconnect")}
          </button>
        </div>
      )}
    </div>
  );
}

// Connected app details sub-component
function AppDetails({ nodeId, sessions, onEvict }: { nodeId: string; sessions: ActiveSessionInfo[]; onEvict: (sessionId: string, subscriberId: string) => void }) {
  const { t } = useTranslation("sessionManager");
  // Parse "app::${sessionId}::${subscriberId}"
  const parts = nodeId.split("::");
  const sessionId = parts[1];
  const subscriberId = parts[2];

  const session = sessions.find((s) => s.sessionId === sessionId);
  const listener = session?.subscribers.find((l) => l.subscriber_id === subscriberId);

  if (!listener) {
    return <p className="text-sm text-[color:var(--text-muted)]">{t("detail.appNotFound")}</p>;
  }

  const formatUptime = (seconds: number): string => {
    if (seconds < 60) return t("detail.uptime.secondsAgo", { count: seconds });
    if (seconds < 3600) return t("detail.uptime.minutesAgo", { count: Math.floor(seconds / 60) });
    return t("detail.uptime.hoursMinutesAgo", {
      hours: Math.floor(seconds / 3600),
      minutes: Math.floor((seconds % 3600) / 60),
    });
  };

  return (
    <div className="space-y-4">
      {/* App ID */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.appId")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)] font-mono">
          {listener.subscriber_id}
        </p>
      </div>

      {/* Session */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.session")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)] font-mono break-all">
          {sessionId}
        </p>
      </div>

      {/* Active status */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.status")}
        </label>
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${listener.is_active ? "bg-green-400" : "bg-gray-500"}`} />
          <p className={`text-sm ${listener.is_active ? "text-green-400" : "text-[color:var(--text-muted)]"}`}>
            {listener.is_active ? t("detail.values.active") : t("detail.values.inactive")}
          </p>
        </div>
      </div>

      {/* Registration time */}
      <div>
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide">
          {t("detail.labels.registered")}
        </label>
        <p className="text-sm text-[color:var(--text-primary)]">
          {formatUptime(listener.registered_seconds_ago)}
        </p>
      </div>

      {/* Actions */}
      <div className="pt-2 border-t border-[color:var(--border-default)]">
        <label className="text-xs text-[color:var(--text-muted)] uppercase tracking-wide mb-2 block">
          {t("detail.labels.actions")}
        </label>
        <button
          onClick={() => onEvict(sessionId, subscriberId)}
          className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${iconButtonHoverDanger}`}
        >
          <UserMinus className={iconSm} />
          {t("detail.actions.remove")}
        </button>
      </div>
    </div>
  );
}
