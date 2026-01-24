// ui/src/dialogs/io-reader-picker/ReaderList.tsx

import { Bookmark, Wifi, Database, FolderOpen, GitMerge, Radio, Play } from "lucide-react";
import type { IOProfile } from "../../hooks/useSettings";
import type { Session } from "../../stores/sessionStore";
import type { ActiveSessionInfo } from "../../api/io";
import { CSV_EXTERNAL_ID, isRealtimeProfile } from "./utils";
import { badgeSmallNeutral, badgeSmallSuccess, badgeSmallWarning, badgeSmallPurple } from "../../styles/badgeStyles";
import type { ReactNode } from "react";

/** Status for a profile that may be disabled */
export interface ProfileDisabledStatus {
  canTransmit: boolean;
  reason?: string;
}

type Props = {
  ioProfiles: IOProfile[];
  checkedReaderId: string | null;
  /** Selected reader IDs when in multi-select mode */
  checkedReaderIds?: string[];
  defaultId?: string | null;
  isIngesting: boolean;
  onSelectReader: (readerId: string | null) => void;
  /** Called when toggling a reader in multi-select mode */
  onToggleReader?: (readerId: string) => void;
  /** Check if a profile has an active session (is "live") */
  isProfileLive?: (profileId: string) => boolean;
  /** Get session for a profile (to check state) */
  getSessionForProfile?: (profileId: string) => Session | undefined;
  /** Enable multi-select mode for real-time profiles */
  multiSelectMode?: boolean;
  /** Callback to toggle multi-select mode */
  onToggleMultiSelectMode?: (enabled: boolean) => void;
  /** Render additional content below a profile when selected in multi-select mode */
  renderProfileExtra?: (profileId: string) => ReactNode;
  /** Active multi-source sessions that can be joined */
  activeMultiSourceSessions?: ActiveSessionInfo[];
  /** Callback when selecting a multi-source session to join */
  onSelectMultiSourceSession?: (sessionId: string) => void;
  /** Map of profile ID to disabled status (for transmit mode) */
  disabledProfiles?: Map<string, ProfileDisabledStatus>;
  /** Hide the External Sources section (CSV) - for transmit mode */
  hideExternal?: boolean;
  /** Hide the Recorded Sources section - for transmit mode */
  hideRecorded?: boolean;
};

export default function ReaderList({
  ioProfiles,
  checkedReaderId,
  checkedReaderIds = [],
  defaultId,
  isIngesting,
  onSelectReader,
  onToggleReader,
  isProfileLive,
  getSessionForProfile,
  multiSelectMode = false,
  onToggleMultiSelectMode,
  renderProfileExtra,
  activeMultiSourceSessions = [],
  onSelectMultiSourceSession,
  disabledProfiles,
  hideExternal = false,
  hideRecorded = false,
}: Props) {
  // All profiles are read profiles now (mode field removed), separate by type
  const readProfiles = ioProfiles;
  const realtimeProfiles = readProfiles.filter(isRealtimeProfile);
  const recordedProfiles = readProfiles.filter((p) => !isRealtimeProfile(p));

  // CAN-capable real-time profiles that support multi-source mode
  const multiSourceCapableProfiles = realtimeProfiles.filter(
    (p) => p.kind === "gvret_tcp" || p.kind === "gvret_usb" ||
           p.kind === "slcan" || p.kind === "gs_usb" || p.kind === "socketcan"
  );

  const isCsvSelected = checkedReaderId === CSV_EXTERNAL_ID;
  const checkedProfile = checkedReaderId && checkedReaderId !== CSV_EXTERNAL_ID
    ? readProfiles.find((p) => p.id === checkedReaderId) || null
    : null;

  // Check if selected reader is a multi-source session
  const checkedMultiSourceSession = checkedReaderId
    ? activeMultiSourceSessions.find((s) => s.sessionId === checkedReaderId) || null
    : null;

  // Get bus number from profile connection config
  const getBusNumber = (profile: IOProfile): number | undefined => {
    const busOverride = profile.connection?.bus_override;
    if (busOverride !== undefined && busOverride !== null && busOverride !== "") {
      return typeof busOverride === "number" ? busOverride : parseInt(busOverride, 10);
    }
    return undefined;
  };

  // When a reader is selected, show only that reader in collapsed view
  if (checkedReaderId && !isIngesting) {
    // Determine display name and subtitle based on selection type
    let displayName: string;
    let subtitle: string;
    let icon: ReactNode = null;

    if (isCsvSelected) {
      displayName = "CSV";
      subtitle = "Import from file";
    } else if (checkedMultiSourceSession) {
      // Multi-source session selected
      const sourceCount = checkedMultiSourceSession.multiSourceConfigs?.length || 0;
      displayName = `Multi-Bus Session (${sourceCount} sources)`;
      subtitle = checkedMultiSourceSession.sessionId;
      icon = <GitMerge className="w-4 h-4 text-purple-500" />;
    } else if (checkedProfile) {
      displayName = checkedProfile.name;
      subtitle = checkedProfile.kind;
    } else {
      displayName = "Unknown";
      subtitle = checkedReaderId;
    }

    return (
      <div className="border-b border-slate-200 dark:border-slate-700">
        <div className="px-4 py-2 bg-slate-50 dark:bg-slate-900/50 text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
          IO Reader
        </div>
        <div className="px-3 py-2">
          <button
            onClick={() => onSelectReader(null)}
            className="w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors bg-blue-50 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700 hover:bg-blue-100 dark:hover:bg-blue-900/30"
          >
            {icon || (
              <div className="w-4 h-4 rounded-full border-2 border-blue-600 dark:border-blue-400 flex items-center justify-center">
                <div className="w-2 h-2 rounded-full bg-blue-600 dark:bg-blue-400" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-slate-900 dark:text-white truncate">
                {displayName}
              </span>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {subtitle}
              </div>
            </div>
            <span className="text-xs text-blue-600 dark:text-blue-400">Change</span>
          </button>
        </div>
      </div>
    );
  }

  // Filter active sessions to only show running ones
  const runningSessions = activeMultiSourceSessions.filter(
    (s) => s.state === "running" || s.state === "starting"
  );

  // Separate multi-source sessions from single-profile sessions
  const runningMultiSourceSessions = runningSessions.filter(
    (s) => s.deviceType === "multi_source"
  );
  const runningRecordedSessions = runningSessions.filter(
    (s) => s.deviceType !== "multi_source"
  );

  // Get profile info for single-profile sessions
  const getProfileForSession = (sessionId: string): IOProfile | null => {
    return readProfiles.find((p) => p.id === sessionId) || null;
  };

  return (
    <div className="border-b border-slate-200 dark:border-slate-700">
      <div className="px-4 py-2 bg-slate-50 dark:bg-slate-900/50 text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
        IO Reader
      </div>

      {/* Active Multi-Bus Sessions (shareable) */}
      {runningMultiSourceSessions.length > 0 && onSelectMultiSourceSession && (
        <div className="border-b border-slate-100 dark:border-slate-700/50">
          <div className="px-4 py-1.5 text-xs text-slate-400 dark:text-slate-500 flex items-center gap-1.5">
            <GitMerge className="w-3 h-3" />
            <span>Active Multi-Bus Sessions</span>
          </div>
          <div className="px-3 pb-2 space-y-1">
            {runningMultiSourceSessions.map((session) => {
              const isSelected = checkedReaderId === session.sessionId;
              const sourceNames = session.multiSourceConfigs
                ?.map((c) => c.displayName || c.profileId)
                .join(" + ") || session.sessionId;

              return (
                <button
                  key={session.sessionId}
                  onClick={() => onSelectMultiSourceSession(session.sessionId)}
                  className={`w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors ${
                    isSelected
                      ? "bg-purple-50 dark:bg-purple-900/20 border border-purple-300 dark:border-purple-700"
                      : "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-purple-300 dark:hover:border-purple-600"
                  }`}
                >
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                    isSelected
                      ? "border-purple-600 dark:border-purple-400"
                      : "border-slate-300 dark:border-slate-600"
                  }`}>
                    {isSelected && (
                      <div className="w-2 h-2 rounded-full bg-purple-600 dark:bg-purple-400" />
                    )}
                  </div>
                  <GitMerge className="w-4 h-4 flex-shrink-0 text-purple-600 dark:text-purple-400" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-900 dark:text-white truncate flex items-center gap-2">
                      <span>{sourceNames}</span>
                      <Radio className="w-3 h-3 text-green-500 animate-pulse" />
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
                      <span className={badgeSmallSuccess}>Live</span>
                      <span>{session.listenerCount} listener{session.listenerCount !== 1 ? "s" : ""}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Active Recorded Sessions (PostgreSQL, etc.) */}
      {runningRecordedSessions.length > 0 && onSelectMultiSourceSession && (
        <div className="border-b border-slate-100 dark:border-slate-700/50">
          <div className="px-4 py-1.5 text-xs text-slate-400 dark:text-slate-500 flex items-center gap-1.5">
            <Play className="w-3 h-3" />
            <span>Active Sessions</span>
          </div>
          <div className="px-3 pb-2 space-y-1">
            {runningRecordedSessions.map((session) => {
              const isSelected = checkedReaderId === session.sessionId;
              const profile = getProfileForSession(session.sessionId);
              const displayName = profile?.name || session.sessionId;
              const deviceKind = profile?.kind || session.deviceType;

              return (
                <button
                  key={session.sessionId}
                  onClick={() => onSelectMultiSourceSession(session.sessionId)}
                  className={`w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors ${
                    isSelected
                      ? "bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-700"
                      : "bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:border-green-300 dark:hover:border-green-600"
                  }`}
                >
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                    isSelected
                      ? "border-green-600 dark:border-green-400"
                      : "border-slate-300 dark:border-slate-600"
                  }`}>
                    {isSelected && (
                      <div className="w-2 h-2 rounded-full bg-green-600 dark:bg-green-400" />
                    )}
                  </div>
                  <Database className="w-4 h-4 flex-shrink-0 text-green-600 dark:text-green-400" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-900 dark:text-white truncate flex items-center gap-2">
                      <span>{displayName}</span>
                      <Radio className="w-3 h-3 text-green-500 animate-pulse" />
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
                      <span className={badgeSmallSuccess}>Live</span>
                      <span>{deviceKind}</span>
                      <span>· {session.listenerCount} listener{session.listenerCount !== 1 ? "s" : ""}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Real-time Sources */}
      {realtimeProfiles.length > 0 && (
        <div className="border-b border-slate-100 dark:border-slate-700/50">
          <div className="px-4 py-1.5 text-xs text-slate-400 dark:text-slate-500 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Wifi className="w-3 h-3" />
              <span>Real-time</span>
              {multiSelectMode && checkedReaderIds.length > 0 && (
                <span className={badgeSmallPurple}>
                  {checkedReaderIds.length} selected
                </span>
              )}
            </div>
            {multiSourceCapableProfiles.length > 1 && onToggleMultiSelectMode && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onToggleMultiSelectMode(false)}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    !multiSelectMode
                      ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300"
                      : "bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600"
                  }`}
                >
                  Single
                </button>
                <button
                  onClick={() => onToggleMultiSelectMode(true)}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors flex items-center gap-1 ${
                    multiSelectMode
                      ? "bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300"
                      : "bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600"
                  }`}
                >
                  <GitMerge className="w-3 h-3" />
                  Multi-Bus
                </button>
              </div>
            )}
          </div>
          <div className="px-3 pb-2 space-y-1">
            {realtimeProfiles.map((profile) => {
              const isProfileChecked = multiSelectMode ? checkedReaderIds.includes(profile.id) : checkedReaderId === profile.id;
              const disabledStatus = disabledProfiles?.get(profile.id);
              const isDisabledForTransmit = disabledStatus && !disabledStatus.canTransmit;
              // In multi-select mode, only CAN-capable real-time profiles can be selected
              const isMultiSourceCapable = profile.kind === "gvret_tcp" || profile.kind === "gvret_usb" ||
                profile.kind === "slcan" || profile.kind === "gs_usb" || profile.kind === "socketcan";
              const isDisabledForMultiSelect = multiSelectMode && !isMultiSourceCapable;
              const isDisabled = isDisabledForTransmit || isDisabledForMultiSelect;
              const disabledReason = isDisabledForTransmit
                ? disabledStatus?.reason
                : isDisabledForMultiSelect
                ? "Not a CAN interface"
                : undefined;
              return (
                <div key={profile.id}>
                  <ReaderButton
                    profile={profile}
                    isChecked={isProfileChecked}
                    isDefault={false}
                    isIngesting={isIngesting}
                    isLive={isProfileLive?.(profile.id) ?? false}
                    sessionState={getSessionForProfile?.(profile.id)?.ioState}
                    onSelect={multiSelectMode && onToggleReader ? () => onToggleReader(profile.id) : onSelectReader}
                    useCheckbox={multiSelectMode}
                    busNumber={getBusNumber(profile)}
                    isDisabled={isDisabled}
                    disabledReason={disabledReason}
                  />
                  {/* Render extra content (e.g., bus config) inline below selected profile */}
                  {multiSelectMode && isProfileChecked && renderProfileExtra?.(profile.id)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recorded Sources */}
      {!hideRecorded && recordedProfiles.length > 0 && (
        <div className="border-b border-slate-100 dark:border-slate-700/50">
          <div className="px-4 py-1.5 text-xs text-slate-400 dark:text-slate-500 flex items-center gap-1.5">
            <Database className="w-3 h-3" />
            <span>Recorded</span>
          </div>
          <div className="px-3 pb-2 space-y-1">
            {recordedProfiles.map((profile) => (
              <ReaderButton
                key={profile.id}
                profile={profile}
                isChecked={checkedReaderId === profile.id}
                isDefault={profile.id === defaultId}
                isIngesting={isIngesting}
                isLive={isProfileLive?.(profile.id) ?? false}
                sessionState={getSessionForProfile?.(profile.id)?.ioState}
                onSelect={onSelectReader}
              />
            ))}
          </div>
        </div>
      )}

      {/* External Sources */}
      {!hideExternal && (
        <div>
          <div className="px-4 py-1.5 text-xs text-slate-400 dark:text-slate-500 flex items-center gap-1.5">
            <FolderOpen className="w-3 h-3" />
            <span>External</span>
          </div>
          <div className="px-3 pb-2 space-y-1">
            <button
              onClick={() => onSelectReader(isCsvSelected ? null : CSV_EXTERNAL_ID)}
              disabled={isIngesting}
              className={`w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors disabled:opacity-50 ${
                isCsvSelected
                  ? "bg-blue-50 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700"
                  : "hover:bg-slate-50 dark:hover:bg-slate-700/50 border border-transparent"
              }`}
            >
              <div
                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                  isCsvSelected
                    ? "border-blue-600 dark:border-blue-400"
                    : "border-slate-300 dark:border-slate-600"
                }`}
              >
                {isCsvSelected && <div className="w-2 h-2 rounded-full bg-blue-600 dark:bg-blue-400" />}
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-slate-900 dark:text-white">CSV</span>
                <div className="text-xs text-slate-500 dark:text-slate-400">Import from file</div>
              </div>
            </button>
          </div>
        </div>
      )}

      {readProfiles.length === 0 && !isCsvSelected && (
        <div className="p-4 text-sm text-slate-500 dark:text-slate-400">
          No IO readers configured. Add one in Settings.
        </div>
      )}
    </div>
  );
}

// Helper component for reader buttons
function ReaderButton({
  profile,
  isChecked,
  isDefault,
  isIngesting,
  isLive,
  sessionState,
  onSelect,
  useCheckbox = false,
  busNumber,
  isDisabled = false,
  disabledReason,
}: {
  profile: IOProfile;
  isChecked: boolean;
  isDefault: boolean;
  isIngesting: boolean;
  isLive: boolean;
  sessionState?: string;
  onSelect: (readerId: string | null) => void;
  useCheckbox?: boolean;
  busNumber?: number;
  isDisabled?: boolean;
  disabledReason?: string;
}) {
  // Determine badge text and colors based on session state
  const isStopped = sessionState === "stopped";
  const isRunning = isLive && sessionState === "running";

  // Live profile gets green styling when checked, amber when stopped
  const liveAndChecked = isLive && isChecked;

  // Checkbox or radio styling
  const indicatorBaseClass = useCheckbox
    ? "w-4 h-4 rounded border-2 flex items-center justify-center"
    : "w-4 h-4 rounded-full border-2 flex items-center justify-center";

  const getIndicatorColor = () => {
    if (isDisabled) {
      return "border-slate-200 dark:border-slate-700";
    }
    if (useCheckbox && isChecked) {
      return "border-purple-600 dark:border-purple-400 bg-purple-600 dark:bg-purple-400";
    }
    if (liveAndChecked) {
      return isStopped
        ? "border-amber-600 dark:border-amber-400"
        : "border-green-600 dark:border-green-400";
    }
    if (isChecked) {
      return "border-blue-600 dark:border-blue-400";
    }
    return "border-slate-300 dark:border-slate-600";
  };

  return (
    <div
      className={`w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors ${
        isDisabled
          ? "opacity-60 cursor-not-allowed border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50"
          : isIngesting
          ? "opacity-50 cursor-not-allowed"
          : useCheckbox && isChecked
          ? "bg-purple-50 dark:bg-purple-900/20 border border-purple-300 dark:border-purple-700 cursor-pointer"
          : liveAndChecked
          ? isStopped
            ? "bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 cursor-pointer"
            : "bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-700 cursor-pointer"
          : isChecked
          ? "bg-blue-50 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700 cursor-pointer"
          : isLive
          ? isStopped
            ? "bg-amber-50/50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 hover:bg-amber-50 dark:hover:bg-amber-900/20 cursor-pointer"
            : "bg-green-50/50 dark:bg-green-900/10 border border-green-200 dark:border-green-800 hover:bg-green-50 dark:hover:bg-green-900/20 cursor-pointer"
          : "hover:bg-slate-50 dark:hover:bg-slate-700/50 border border-transparent cursor-pointer"
      }`}
      onClick={isDisabled || isIngesting ? undefined : () => onSelect(isChecked && !useCheckbox ? null : profile.id)}
      role={isDisabled ? undefined : "button"}
      tabIndex={isDisabled ? undefined : 0}
    >
      <div className={`${indicatorBaseClass} ${getIndicatorColor()}`}>
        {!isDisabled && useCheckbox && isChecked ? (
          <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : !isDisabled && isChecked && !useCheckbox ? (
          <div className={`w-2 h-2 rounded-full ${
            liveAndChecked
              ? isStopped
                ? "bg-amber-600 dark:bg-amber-400"
                : "bg-green-600 dark:bg-green-400"
              : "bg-blue-600 dark:bg-blue-400"
          }`} />
        ) : null}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {isDefault && <Bookmark className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" fill="currentColor" />}
          <span className={`text-sm font-medium truncate ${isDisabled ? "text-slate-400 dark:text-slate-500" : "text-slate-900 dark:text-white"}`}>
            {profile.name}
          </span>
          {busNumber !== undefined && (
            <span className={badgeSmallNeutral}>
              Bus {busNumber}
            </span>
          )}
          {isLive && !isDisabled && (
            isStopped ? (
              <span className={badgeSmallWarning}>Stopped</span>
            ) : isRunning ? (
              <span className={badgeSmallSuccess}>Live</span>
            ) : (
              <span className={badgeSmallSuccess}>Active</span>
            )
          )}
        </div>
        <div className={`text-xs ${isDisabled ? "text-slate-400 dark:text-slate-600" : "text-slate-500 dark:text-slate-400"}`}>
          {isDisabled && disabledReason ? (
            <span>{profile.kind} · <span className="text-slate-400 dark:text-slate-500">{disabledReason}</span></span>
          ) : (
            profile.kind
          )}
        </div>
      </div>
    </div>
  );
}
