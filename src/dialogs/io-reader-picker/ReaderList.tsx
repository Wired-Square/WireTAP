// ui/src/dialogs/io-reader-picker/ReaderList.tsx

import { Bookmark, Wifi, Database, FolderOpen, GitMerge, Radio, Play, Lock } from "lucide-react";
import type { IOProfile } from "../../hooks/useSettings";
import type { Session } from "../../stores/sessionStore";
import type { ActiveSessionInfo, ProfileUsageInfo } from "../../api/io";
import { CSV_EXTERNAL_ID, isRealtimeProfile, isMultiSourceCapable } from "./utils";
import { badgeSmallNeutral, badgeSmallSuccess, badgeSmallWarning, badgeSmallPurple, badgeSmallInfo } from "../../styles/badgeStyles";
import { iconMd, iconSm, iconXs, flexRowGap2 } from "../../styles/spacing";
import { sectionHeader, caption, captionMuted, textMedium } from "../../styles/typography";
import { borderDivider, bgSurface } from "../../styles";
import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";

/** Status for a profile that may be disabled */
export interface ProfileDisabledStatus {
  canTransmit: boolean;
  reason?: string;
}

type Props = {
  ioProfiles: IOProfile[];
  checkedReaderId: string | null;
  /** Selected reader IDs for multi-bus sessions */
  checkedReaderIds?: string[];
  defaultId?: string | null;
  isIngesting: boolean;
  onSelectReader: (readerId: string | null) => void;
  /** Called when toggling a multi-source-capable reader */
  onToggleReader?: (readerId: string) => void;
  /** Check if a profile has an active session (is "live") */
  isProfileLive?: (profileId: string) => boolean;
  /** Get session for a profile (to check state) */
  getSessionForProfile?: (profileId: string) => Session | undefined;
  /** Render additional content below a profile when selected */
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
  /** Validation error for incompatible selection */
  validationError?: string | null;
  /** Allow multi-select mode (default: true for real-time CAN interfaces) */
  allowMultiSelect?: boolean;
  /** Profile usage info - which sessions are using each profile */
  profileUsage?: Map<string, ProfileUsageInfo>;
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
  renderProfileExtra,
  activeMultiSourceSessions = [],
  onSelectMultiSourceSession,
  disabledProfiles,
  hideExternal = false,
  hideRecorded = false,
  validationError,
  allowMultiSelect = true,
  profileUsage,
}: Props) {
  // All profiles are read profiles now (mode field removed), separate by type
  const readProfiles = ioProfiles;
  const realtimeProfiles = readProfiles.filter(isRealtimeProfile);
  const recordedProfiles = readProfiles.filter((p) => !isRealtimeProfile(p));

  // Multi-bus mode is implicit when >1 interface is selected
  const isMultiBusMode = checkedReaderIds.length > 1;

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

  // When a single reader is selected (not multi-bus) and not ingesting, show collapsed view
  // Multi-bus mode (checkedReaderIds.length > 0) always shows full list
  if (checkedReaderId && checkedReaderIds.length === 0 && !isIngesting) {
    // Determine display name and subtitle based on selection type
    let displayName: string;
    let subtitle: string;
    let icon: ReactNode = null;

    if (isCsvSelected) {
      displayName = "CSV";
      subtitle = "Import from file";
    } else if (checkedMultiSourceSession) {
      // Active session selected - show session ID as name, sources with bus mappings below
      displayName = checkedMultiSourceSession.sessionId;
      const sourceDetails = checkedMultiSourceSession.multiSourceConfigs
        ?.map((c) => {
          const name = c.displayName || c.profileId;
          const enabledMappings = c.busMappings.filter((m) => m.enabled);
          if (enabledMappings.length === 0) {
            return name;
          }
          const mappingStr = enabledMappings
            .map((m) => `${m.deviceBus}→${m.outputBus}`)
            .join(", ");
          return `${name} (${mappingStr})`;
        })
        .join(" + ") || "";
      subtitle = sourceDetails ? `└─ ${sourceDetails}` : "";
      icon = <GitMerge className={`${iconMd} text-[color:var(--text-purple)]`} />;
    } else if (checkedProfile) {
      displayName = checkedProfile.name;
      subtitle = checkedProfile.kind;
    } else {
      displayName = "Unknown";
      subtitle = checkedReaderId;
    }

    // Use purple styling for active sessions, blue for profiles
    const isActiveSession = checkedMultiSourceSession !== null;
    const bgClass = isActiveSession
      ? "bg-[var(--status-purple-bg)] border border-[color:var(--status-purple-border)]"
      : "bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)]";
    const indicatorClass = isActiveSession
      ? "border-[color:var(--text-purple)]"
      : "border-[color:var(--status-info-text)]";
    const dotClass = isActiveSession
      ? "bg-[var(--text-purple)]"
      : "bg-[var(--status-info-text)]";
    const changeClass = isActiveSession
      ? "text-[color:var(--text-purple)]"
      : "text-[color:var(--status-info-text)]";

    return (
      <div className={borderDivider}>
        <div className={`px-4 py-2 bg-[var(--bg-surface)] ${sectionHeader}`}>
          IO Reader
        </div>
        <div className="px-3 py-2">
          <button
            onClick={() => onSelectReader(null)}
            className={`w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors hover:brightness-95 ${bgClass}`}
          >
            {icon || (
              <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${indicatorClass}`}>
                <div className={`w-2 h-2 rounded-full ${dotClass}`} />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <span className={`${textMedium} truncate`}>
                {displayName}
              </span>
              <div className={`${caption} text-[color:var(--text-muted)]`}>
                {subtitle}
              </div>
            </div>
            <span className={`text-xs ${changeClass}`}>Change</span>
          </button>
        </div>
      </div>
    );
  }

  // Filter active sessions to show joinable ones (running, starting, paused, or stopped)
  const joinableSessions = activeMultiSourceSessions.filter(
    (s) => s.state === "running" || s.state === "starting" || s.state === "paused" || s.state === "stopped"
  );

  // Get profile info for single-profile sessions
  const getProfileForSession = (sessionId: string): IOProfile | null => {
    return readProfiles.find((p) => p.id === sessionId) || null;
  };

  // Get display info for a session
  const getSessionDisplayInfo = (session: ActiveSessionInfo) => {
    const isMultiSource = session.deviceType === "multi_source";
    const isBuffer = session.deviceType === "buffer";
    // Always use session ID as the primary display name
    const displayName = session.sessionId;

    if (isMultiSource) {
      // Multi-source session: show sources with bus mappings
      const sourceDetails = session.multiSourceConfigs
        ?.map((c) => {
          const name = c.displayName || c.profileId;
          const enabledMappings = c.busMappings.filter((m) => m.enabled);
          if (enabledMappings.length === 0) {
            return name;
          }
          const mappingStr = enabledMappings
            .map((m) => `${m.deviceBus}→${m.outputBus}`)
            .join(", ");
          return `${name} (${mappingStr})`;
        })
        .join(" + ") || "";

      return {
        displayName,
        subtitle: `${session.listenerCount} listener${session.listenerCount !== 1 ? "s" : ""}`,
        sourceDetails,
        icon: GitMerge,
        iconColour: "text-[color:var(--text-purple)]",
        bgSelected: "bg-[var(--status-purple-bg)] border border-[color:var(--status-purple-border)]",
        bgHover: `${bgSurface} border border-[color:var(--border-default)] hover:border-[color:var(--text-purple)]`,
        indicatorColour: "border-[color:var(--text-purple)]",
        dotColour: "bg-[var(--text-purple)]",
      };
    } else if (isBuffer) {
      // Buffer replay session (stopped live session switched to buffer playback)
      // Look up original profile from session's source profiles
      const sourceProfileIds = session.sourceProfileIds ?? [];
      const originalProfile = sourceProfileIds.length > 0
        ? readProfiles.find((p) => sourceProfileIds.includes(p.id))
        : null;
      const profileName = originalProfile?.name || "Buffer";
      return {
        displayName,
        subtitle: `${session.listenerCount} listener${session.listenerCount !== 1 ? "s" : ""}`,
        sourceDetails: `${profileName} (buffer replay)`,
        icon: Play,
        iconColour: "text-[color:var(--text-cyan)]",
        bgSelected: "bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)]",
        bgHover: `${bgSurface} border border-[color:var(--border-default)] hover:border-[color:var(--text-cyan)]`,
        indicatorColour: "border-[color:var(--text-cyan)]",
        dotColour: "bg-[var(--text-cyan)]",
      };
    } else {
      // Single-source session (e.g., PostgreSQL)
      const profile = getProfileForSession(session.sessionId);
      const profileName = profile?.name || session.deviceType;
      const deviceKind = profile?.kind || session.deviceType;
      return {
        displayName,
        subtitle: `${session.listenerCount} listener${session.listenerCount !== 1 ? "s" : ""}`,
        sourceDetails: `${profileName} (${deviceKind})`,
        icon: Database,
        iconColour: "text-[color:var(--text-green)]",
        bgSelected: "bg-[var(--status-success-bg)] border border-[color:var(--status-success-border)]",
        bgHover: `${bgSurface} border border-[color:var(--border-default)] hover:border-[color:var(--text-green)]`,
        indicatorColour: "border-[color:var(--text-green)]",
        dotColour: "bg-[var(--text-green)]",
      };
    }
  };

  return (
    <div className={borderDivider}>
      <div className={`px-4 py-2 bg-[var(--bg-surface)] ${sectionHeader}`}>
        IO Reader
      </div>

      {/* Active Sessions (all types combined - join existing) */}
      {joinableSessions.length > 0 && onSelectMultiSourceSession && (
        <div className="border-b border-[color:var(--border-default)]">
          <div className={`px-4 py-1.5 ${captionMuted} flex items-center gap-1.5`}>
            <Play className={iconXs} />
            <span>Active Sessions</span>
            <span className={badgeSmallSuccess}>{joinableSessions.length}</span>
          </div>
          <div className="px-3 pb-2 space-y-1">
            {joinableSessions.map((session) => {
              const isSelected = checkedReaderId === session.sessionId;
              const info = getSessionDisplayInfo(session);
              const IconComponent = info.icon;

              return (
                <button
                  key={session.sessionId}
                  onClick={() => onSelectMultiSourceSession(session.sessionId)}
                  className={`w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors ${
                    isSelected ? info.bgSelected : info.bgHover
                  }`}
                >
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                    isSelected ? info.indicatorColour : "border-[color:var(--border-default)]"
                  }`}>
                    {isSelected && (
                      <div className={`w-2 h-2 rounded-full ${info.dotColour}`} />
                    )}
                  </div>
                  <IconComponent className={`${iconMd} flex-shrink-0 ${info.iconColour}`} />
                  <div className="flex-1 min-w-0">
                    <div className={`${textMedium} truncate flex items-center gap-2`}>
                      <span>{info.displayName}</span>
                      {session.state !== "stopped" && session.deviceType !== "buffer" && (
                        <Radio className={`${iconXs} text-green-500 animate-pulse`} />
                      )}
                    </div>
                    <div className={`${caption} flex items-center gap-2`}>
                      {session.state === "stopped" ? (
                        <span className={badgeSmallWarning}>Stopped</span>
                      ) : session.state === "paused" && session.deviceType === "buffer" ? (
                        <span className={badgeSmallInfo}>Paused</span>
                      ) : session.deviceType === "buffer" ? (
                        <span className={badgeSmallInfo}>Playing</span>
                      ) : (
                        <span className={badgeSmallSuccess}>Live</span>
                      )}
                      <span>{info.subtitle}</span>
                      {/* Show buffer info if available */}
                      {session.bufferId && (
                        <>
                          <span className="text-[color:var(--text-muted)]">·</span>
                          <span className="text-[color:var(--text-cyan)]">
                            {session.bufferFrameCount?.toLocaleString() ?? "?"} frames
                          </span>
                        </>
                      )}
                    </div>
                    {/* Show source details with bus mappings */}
                    {info.sourceDetails && (
                      <div className={`${caption} text-[color:var(--text-muted)] truncate mt-0.5`}>
                        └─ {info.sourceDetails}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Real-time Sources */}
      {realtimeProfiles.length > 0 && (
        <div className="border-b border-[color:var(--border-default)]">
          <div className={`px-4 py-1.5 ${captionMuted} flex items-center justify-between`}>
            <div className="flex items-center gap-1.5">
              <Wifi className={iconXs} />
              <span>Real-time</span>
              {isMultiBusMode && (
                <span className={badgeSmallPurple}>
                  <GitMerge className={`${iconXs} inline mr-1`} />
                  {checkedReaderIds.length} buses
                </span>
              )}
            </div>
          </div>
          {/* Validation error */}
          {validationError && (
            <div className="mx-3 mb-2 px-3 py-2 text-xs text-[color:var(--status-danger-text)] bg-[var(--status-danger-bg)] border border-[color:var(--status-danger-border)] rounded-lg flex items-center gap-2">
              <AlertCircle className={`${iconMd} flex-shrink-0`} />
              <span>{validationError}</span>
            </div>
          )}
          <div className="px-3 pb-2 space-y-1">
            {realtimeProfiles.map((profile) => {
              const canMultiSelect = allowMultiSelect && isMultiSourceCapable(profile);
              const isProfileChecked = canMultiSelect
                ? checkedReaderIds.includes(profile.id)
                : checkedReaderId === profile.id;
              const disabledStatus = disabledProfiles?.get(profile.id);
              const isDisabledForTransmit = disabledStatus && !disabledStatus.canTransmit;
              const isDisabled = isDisabledForTransmit;
              const disabledReason = isDisabledForTransmit ? disabledStatus?.reason : undefined;

              // Handler: multi-source-capable profiles toggle, others select exclusively
              const handleSelect = canMultiSelect && onToggleReader
                ? () => onToggleReader(profile.id)
                : onSelectReader;

              // Get usage info for this profile
              const usage = profileUsage?.get(profile.id);

              return (
                <div key={profile.id}>
                  <ReaderButton
                    profile={profile}
                    isChecked={isProfileChecked}
                    isDefault={false}
                    isIngesting={isIngesting}
                    isLive={isProfileLive?.(profile.id) ?? false}
                    sessionState={getSessionForProfile?.(profile.id)?.ioState}
                    onSelect={handleSelect}
                    useCheckbox={canMultiSelect}
                    busNumber={getBusNumber(profile)}
                    isDisabled={isDisabled}
                    disabledReason={disabledReason}
                    usageInfo={usage}
                  />
                  {/* Render extra content (e.g., bus config) inline below selected profile */}
                  {isProfileChecked && renderProfileExtra?.(profile.id)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recorded Sources */}
      {!hideRecorded && recordedProfiles.length > 0 && (
        <div className="border-b border-[color:var(--border-default)]">
          <div className={`px-4 py-1.5 ${captionMuted} flex items-center gap-1.5`}>
            <Database className={iconXs} />
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
                usageInfo={profileUsage?.get(profile.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* External Sources */}
      {!hideExternal && (
        <div>
          <div className={`px-4 py-1.5 ${captionMuted} flex items-center gap-1.5`}>
            <FolderOpen className={iconXs} />
            <span>External</span>
          </div>
          <div className="px-3 pb-2 space-y-1">
            <button
              onClick={() => onSelectReader(isCsvSelected ? null : CSV_EXTERNAL_ID)}
              disabled={isIngesting}
              className={`w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors disabled:opacity-50 ${
                isCsvSelected
                  ? "bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)]"
                  : "hover:bg-[var(--hover-bg)] border border-transparent"
              }`}
            >
              <div
                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                  isCsvSelected
                    ? "border-[color:var(--status-info-text)]"
                    : "border-[color:var(--border-default)]"
                }`}
              >
                {isCsvSelected && <div className="w-2 h-2 rounded-full bg-[var(--status-info-text)]" />}
              </div>
              <div className="flex-1 min-w-0">
                <span className={textMedium}>CSV</span>
                <div className={caption}>Import from file</div>
              </div>
            </button>
          </div>
        </div>
      )}

      {readProfiles.length === 0 && !isCsvSelected && (
        <div className="p-4 text-sm text-[color:var(--text-muted)]">
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
  usageInfo,
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
  usageInfo?: ProfileUsageInfo;
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
      return "border-[color:var(--border-default)]";
    }
    if (useCheckbox && isChecked) {
      return "border-[color:var(--text-purple)] bg-[var(--text-purple)]";
    }
    if (liveAndChecked) {
      return isStopped
        ? "border-[color:var(--text-amber)]"
        : "border-[color:var(--text-green)]";
    }
    if (isChecked) {
      return "border-[color:var(--status-info-text)]";
    }
    return "border-[color:var(--border-default)]";
  };

  return (
    <div
      className={`w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors ${
        isDisabled
          ? "opacity-60 cursor-not-allowed border border-[color:var(--border-default)] bg-[var(--bg-surface)]"
          : isIngesting
          ? "opacity-50 cursor-not-allowed"
          : useCheckbox && isChecked
          ? "bg-[var(--status-purple-bg)] border border-[color:var(--status-purple-border)] cursor-pointer"
          : liveAndChecked
          ? isStopped
            ? "bg-[var(--status-warning-bg)] border border-[color:var(--status-warning-border)] cursor-pointer"
            : "bg-[var(--status-success-bg)] border border-[color:var(--status-success-border)] cursor-pointer"
          : isChecked
          ? "bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)] cursor-pointer"
          : isLive
          ? isStopped
            ? "bg-[var(--status-warning-bg)]/50 border border-[color:var(--status-warning-border)] hover:bg-[var(--status-warning-bg)] cursor-pointer"
            : "bg-[var(--status-success-bg)]/50 border border-[color:var(--status-success-border)] hover:bg-[var(--status-success-bg)] cursor-pointer"
          : "hover:bg-[var(--hover-bg)] border border-transparent cursor-pointer"
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
                ? "bg-[var(--text-amber)]"
                : "bg-[var(--text-green)]"
              : "bg-[var(--status-info-text)]"
          }`} />
        ) : null}
      </div>
      <div className="flex-1 min-w-0">
        <div className={flexRowGap2}>
          {isDefault && <Bookmark className={`${iconSm} text-amber-500 flex-shrink-0`} fill="currentColor" />}
          <span className={`${textMedium} truncate ${isDisabled ? "!text-[color:var(--text-muted)]" : ""}`}>
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
        <div className={`text-xs ${isDisabled ? "text-[color:var(--text-muted)]" : "text-[color:var(--text-muted)]"}`}>
          {isDisabled && disabledReason ? (
            <span>{profile.kind} · <span className="text-[color:var(--text-muted)]">{disabledReason}</span></span>
          ) : usageInfo && usageInfo.sessionCount > 0 ? (
            <span className="flex items-center gap-1">
              <span>{profile.kind}</span>
              <span className="text-[color:var(--text-muted)]">·</span>
              {usageInfo.configLocked && (
                <span title="Config locked (in use by multiple sessions)">
                  <Lock className={`${iconXs} text-[color:var(--text-amber)]`} />
                </span>
              )}
              <span className="text-[color:var(--text-purple)]">
                in use: {usageInfo.sessionIds.slice(0, 2).join(", ")}
                {usageInfo.sessionCount > 2 && ` +${usageInfo.sessionCount - 2}`}
              </span>
            </span>
          ) : (
            profile.kind
          )}
        </div>
      </div>
    </div>
  );
}
