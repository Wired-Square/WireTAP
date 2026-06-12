// ui/src/dialogs/io-source-picker/SourceList.tsx

import { useTranslation } from "react-i18next";
import { Bookmark, Wifi, Database, FolderOpen, GitMerge, Radio, Play, Lock } from "lucide-react";
import type { IOProfile } from "../../hooks/useSettings";
import type { Session } from "../../stores/sessionStore";
import type { ActiveSessionInfo, ProfileUsageInfo } from "../../api/io";
import { CSV_EXTERNAL_ID, isRealtimeProfile, isMultiSourceCapable } from "./utils";
import SourceTabs, { type SourceTab } from "./SourceTabs";
import { badgeSmallNeutral, badgeSmallSuccess, badgeSmallWarning, badgeSmallPurple, badgeSmallInfo } from "../../styles/badgeStyles";
import { iconMd, iconSm, iconXs, flexRowGap2 } from "../../styles/spacing";
import { sectionHeader, caption, captionMuted, textMedium } from "../../styles/typography";
import { borderDivider, bgSurface } from "../../styles";
import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";

/**
 * Map buffer device type to a human-readable storage backend label.
 * Extensible for future buffer mechanisms (e.g., "parquet", "memory").
 */
function getCaptureStorageLabel(_sourceType: string): string {
  // Currently all buffers use SQLite. When new buffer backends are added,
  // the backend should report a storage_type field on ActiveSessionInfo
  // and this function should switch on it.
  return "sqlite";
}

/** Status for a profile that may be disabled */
export interface ProfileDisabledStatus {
  canTransmit: boolean;
  reason?: string;
}

type Props = {
  ioProfiles: IOProfile[];
  checkedSourceId: string | null;
  /** Selected source IDs for multi-bus sessions */
  checkedSourceIds?: string[];
  defaultId?: string | null;
  isLoading: boolean;
  onSelectSource: (sourceId: string | null) => void;
  /** Called when toggling a multi-source-capable source */
  onToggleSource?: (sourceId: string) => void;
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
  /** Hide the Sessions tab (joinable live sessions) - for recorded-only pickers like Query */
  hideSessions?: boolean;
  /** Validation error for incompatible selection */
  validationError?: string | null;
  /** Allow multi-select mode (default: true for real-time CAN interfaces) */
  allowMultiSelect?: boolean;
  /** Profile usage info - which sessions are using each profile */
  profileUsage?: Map<string, ProfileUsageInfo>;
  /** Content to render in the Captures tab body (e.g., CaptureList) */
  renderAfterSessions?: ReactNode;
  /** Map of buffer ID to display name (for resolving buffer source names in active sessions) */
  captureNames?: Map<string, string>;
  /** Active tab in the source picker */
  activeTab: SourceTab;
  /** Called when the active tab changes */
  onTabChange: (tab: SourceTab) => void;
  /** Number of orphaned captures (for the Captures tab badge) */
  captureCount?: number;
};

export default function SourceList({
  ioProfiles,
  checkedSourceId,
  checkedSourceIds = [],
  defaultId,
  isLoading,
  onSelectSource,
  onToggleSource,
  isProfileLive,
  getSessionForProfile,
  renderProfileExtra,
  activeMultiSourceSessions = [],
  onSelectMultiSourceSession,
  disabledProfiles,
  hideExternal = false,
  hideRecorded = false,
  hideSessions = false,
  validationError,
  allowMultiSelect = true,
  profileUsage,
  renderAfterSessions,
  captureNames,
  activeTab,
  onTabChange,
  captureCount = 0,
}: Props) {
  const { t } = useTranslation("dialogs");
  // All profiles are read profiles now (mode field removed), separate by type
  const readProfiles = ioProfiles;
  const realtimeProfiles = readProfiles.filter(isRealtimeProfile);
  const recordedProfiles = readProfiles.filter((p) => !isRealtimeProfile(p));

  // Multi-bus mode is implicit when >1 interface is selected
  const isMultiBusMode = checkedSourceIds.length > 1;

  const isCsvSelected = checkedSourceId === CSV_EXTERNAL_ID;
  const checkedProfile = checkedSourceId && checkedSourceId !== CSV_EXTERNAL_ID
    ? readProfiles.find((p) => p.id === checkedSourceId) || null
    : null;

  // Get bus number from profile connection config
  const getBusNumber = (profile: IOProfile): number | undefined => {
    const busOverride = (profile.connection as Record<string, unknown>)?.bus_override;
    if (busOverride !== undefined && busOverride !== null && busOverride !== "") {
      return typeof busOverride === "number" ? busOverride : parseInt(String(busOverride), 10);
    }
    return undefined;
  };

  // Get profile info for a session ID
  const getProfileForSession = (sessionId: string): IOProfile | null => {
    return readProfiles.find((p) => p.id === sessionId) || null;
  };

  // Collapsed single-source card — rendered in the active tab body once a
  // profile (or CSV) is selected. Active-session selections highlight in place
  // above the tabs instead, so they don't collapse here.
  const renderCollapsedSource = (): ReactNode => {
    // Only CSV or a real profile reach here (active sessions never collapse).
    const displayName = isCsvSelected
      ? t("ioSourcePicker.sources.csv")
      : checkedProfile?.name ?? t("ioSourcePicker.sources.unknown");
    const subtitle = isCsvSelected
      ? t("ioSourcePicker.sources.csvImport")
      : checkedProfile?.kind ?? checkedSourceId ?? "";

    return (
      <div>
        <div className={`px-4 py-2 bg-[var(--bg-surface)] ${sectionHeader}`}>
          {t("ioSourcePicker.sources.source")}
        </div>
        <div className="px-3 py-2">
          <button
            onClick={() => onSelectSource(null)}
            className="w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors hover:brightness-95 bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)]"
          >
            <div className="w-4 h-4 rounded-full border-2 flex items-center justify-center border-[color:var(--status-info-text)]">
              <div className="w-2 h-2 rounded-full bg-[var(--status-info-text)]" />
            </div>
            <div className="flex-1 min-w-0">
              <span className={`${textMedium} truncate`}>{displayName}</span>
              <div className={`${caption} text-[color:var(--text-muted)]`}>{subtitle}</div>
            </div>
            <span className="text-xs text-[color:var(--status-info-text)]">{t("ioSourcePicker.sources.change")}</span>
          </button>
        </div>
      </div>
    );
  };

  // Filter active sessions to show joinable ones (running, starting, paused, or stopped)
  const joinableSessions = activeMultiSourceSessions.filter(
    (s) => s.state === "running" || s.state === "starting" || s.state === "paused" || s.state === "stopped"
  );

  // Get display info for a session
  const getSessionDisplayInfo = (session: ActiveSessionInfo) => {
    const isMultiSource = session.sourceType === "realtime";
    const isCapture = session.sourceType === "capture";
    // Always use session ID as the primary display name
    const displayName = session.sessionId;

    if (isMultiSource) {
      // Multi-source session: show sources with bus mappings
      const sourceDetails = session.brokerConfigs
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
        subtitle: `${session.subscriberCount} subscriber${session.subscriberCount !== 1 ? "s" : ""}`,
        sourceDetails,
        icon: GitMerge,
        iconColour: "text-[color:var(--text-purple)]",
        bgSelected: "bg-[var(--status-purple-bg)] border border-[color:var(--status-purple-border)]",
        bgHover: `${bgSurface} border border-[color:var(--border-default)] hover:border-[color:var(--text-purple)]`,
        indicatorColour: "border-[color:var(--text-purple)]",
        dotColour: "bg-[var(--text-purple)]",
      };
    } else if (isCapture) {
      // Buffer session — cyan database icon, resolve name from buffer metadata
      const storageBackend = getCaptureStorageLabel(session.sourceType);
      const captureId = session.captureId
        ?? (session.sourceProfileIds ?? [])[0];
      const captureName = captureId ? captureNames?.get(captureId) : undefined;
      const profileName = captureName || storageBackend;
      return {
        displayName,
        subtitle: `${session.subscriberCount} subscriber${session.subscriberCount !== 1 ? "s" : ""}`,
        sourceDetails: `${profileName} (${storageBackend})`,
        icon: Database,
        iconColour: "text-[color:var(--text-cyan)]",
        bgSelected: "bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)]",
        bgHover: `${bgSurface} border border-[color:var(--border-default)] hover:border-[color:var(--text-cyan)]`,
        indicatorColour: "border-[color:var(--text-cyan)]",
        dotColour: "bg-[var(--text-cyan)]",
      };
    } else {
      // Single-source session (e.g., PostgreSQL)
      // Look up profile via sourceProfileIds (session IDs like t_XXXXX differ from profile IDs)
      const sourceProfileIds = session.sourceProfileIds ?? [];
      const profile = sourceProfileIds.length > 0
        ? readProfiles.find((p) => sourceProfileIds.includes(p.id))
        : getProfileForSession(session.sessionId);
      const profileName = profile?.name || session.sourceType;
      const deviceKind = profile?.kind || session.sourceType;
      return {
        displayName,
        subtitle: `${session.subscriberCount} subscriber${session.subscriberCount !== 1 ? "s" : ""}`,
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

  // Which tab does the current single-source selection belong to? Active-session
  // selections highlight in place above the tabs and never collapse.
  const isActiveSessionSelected =
    !!checkedSourceId && joinableSessions.some((s) => s.sessionId === checkedSourceId);
  const selectionTab: SourceTab | null = isCsvSelected
    ? "captures"
    : checkedProfile
    ? isRealtimeProfile(checkedProfile)
      ? "devices"
      : "captures"
    : null;

  // Sessions tab holds joinable active sessions.
  const showSessionsTab = !hideSessions && joinableSessions.length > 0 && !!onSelectMultiSourceSession;
  // Captures tab holds SQLite captures + recorded DB sources + CSV import.
  const showCapturesTab =
    !!renderAfterSessions || (!hideRecorded && recordedProfiles.length > 0) || !hideExternal;
  const showDevicesTab = realtimeProfiles.length > 0;
  const availableTabs = [
    showSessionsTab && "sessions",
    showCapturesTab && "captures",
    showDevicesTab && "devices",
  ].filter(Boolean) as SourceTab[];
  const effectiveTab: SourceTab = availableTabs.includes(activeTab)
    ? activeTab
    : availableTabs[0] ?? "devices";

  const showCollapsed =
    !!checkedSourceId &&
    checkedSourceIds.length === 0 &&
    !isLoading &&
    !isActiveSessionSelected &&
    selectionTab !== null &&
    selectionTab === effectiveTab;

  const tabDefs = [
    {
      id: "sessions" as const,
      label: t("ioSourcePicker.tabs.sessions"),
      icon: <Play className={iconXs} />,
      count: joinableSessions.length,
    },
    {
      id: "captures" as const,
      label: t("ioSourcePicker.tabs.captures"),
      icon: <Database className={iconXs} />,
      count: captureCount + recordedProfiles.length,
    },
    {
      id: "devices" as const,
      label: t("ioSourcePicker.tabs.devices"),
      icon: <Wifi className={iconXs} />,
      count: realtimeProfiles.length,
    },
  ].filter((tab) => availableTabs.includes(tab.id));

  // ── Captures tab body: CaptureList slot + recorded DB sources + CSV import ──
  const capturesBody = (
    <>
      {renderAfterSessions}

      {!hideRecorded && recordedProfiles.length > 0 && (
        <div className="border-b border-[color:var(--border-default)]">
          <div className={`px-4 py-1.5 ${captionMuted} flex items-center gap-1.5`}>
            <Database className={iconXs} />
            <span>{t("ioSourcePicker.sources.recorded")}</span>
          </div>
          <div className="px-3 pb-2 space-y-1">
            {recordedProfiles.map((profile) => (
              <SourceButton
                key={profile.id}
                profile={profile}
                isChecked={checkedSourceId === profile.id}
                isDefault={profile.id === defaultId}
                isLoading={isLoading}
                isLive={isProfileLive?.(profile.id) ?? false}
                sessionState={getSessionForProfile?.(profile.id)?.ioState}
                onSelect={onSelectSource}
                usageInfo={profileUsage?.get(profile.id)}
                isRealtime={false}
              />
            ))}
          </div>
        </div>
      )}

      {!hideExternal && (
        <div className="border-b border-[color:var(--border-default)]">
          <div className={`px-4 py-1.5 ${captionMuted} flex items-center gap-1.5`}>
            <FolderOpen className={iconXs} />
            <span>{t("ioSourcePicker.sources.external")}</span>
          </div>
          <div className="px-3 pb-2 space-y-1">
            <button
              onClick={() => onSelectSource(isCsvSelected ? null : CSV_EXTERNAL_ID)}
              disabled={isLoading}
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
                <span className={textMedium}>{t("ioSourcePicker.sources.csv")}</span>
                <div className={caption}>{t("ioSourcePicker.sources.csvImport")}</div>
              </div>
            </button>
          </div>
        </div>
      )}
    </>
  );

  // ── Devices tab body: real-time sources ──
  const devicesBody = realtimeProfiles.length > 0 && (
    <div className="border-b border-[color:var(--border-default)]">
      <div className={`px-4 py-1.5 ${captionMuted} flex items-center justify-between`}>
        <div className="flex items-center gap-1.5">
          <Wifi className={iconXs} />
          <span>{t("ioSourcePicker.sources.realtime")}</span>
          {isMultiBusMode && (
            <span className={badgeSmallPurple}>
              <GitMerge className={`${iconXs} inline mr-1`} />
              {t("ioSourcePicker.sources.busesCount", { count: checkedSourceIds.length })}
            </span>
          )}
        </div>
      </div>
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
            ? checkedSourceIds.includes(profile.id)
            : checkedSourceId === profile.id;
          const disabledStatus = disabledProfiles?.get(profile.id);
          const isDisabledForTransmit = disabledStatus && !disabledStatus.canTransmit;
          const isDisabled = isDisabledForTransmit;
          const disabledReason = isDisabledForTransmit ? disabledStatus?.reason : undefined;

          // Handler: multi-source-capable profiles toggle, others select exclusively
          const handleSelect = canMultiSelect && onToggleSource
            ? () => onToggleSource(profile.id)
            : onSelectSource;

          const usage = profileUsage?.get(profile.id);

          return (
            <div key={profile.id}>
              <SourceButton
                profile={profile}
                isChecked={isProfileChecked}
                isDefault={false}
                isLoading={isLoading}
                isLive={isProfileLive?.(profile.id) ?? false}
                sessionState={getSessionForProfile?.(profile.id)?.ioState}
                onSelect={handleSelect}
                useCheckbox={canMultiSelect}
                busNumber={getBusNumber(profile)}
                isDisabled={isDisabled}
                disabledReason={disabledReason}
                usageInfo={usage}
                isRealtime
              />
              {/* Render extra content (e.g., bus config) inline below selected profile */}
              {isProfileChecked && renderProfileExtra?.(profile.id)}
            </div>
          );
        })}
      </div>
    </div>
  );

  // ── Sessions tab body: joinable active sessions ──
  const sessionsBody = (
    <div className="border-b border-[color:var(--border-default)]">
      <div className="px-3 pt-2 pb-2 space-y-1">
        {joinableSessions.map((session) => {
          const isSelected = checkedSourceId === session.sessionId;
          const info = getSessionDisplayInfo(session);
          const IconComponent = info.icon;

          return (
            <button
              key={session.sessionId}
              onClick={() => onSelectMultiSourceSession?.(session.sessionId)}
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
                  {session.state !== "stopped" && session.sourceType !== "capture" && (
                    <Radio className={`${iconXs} text-green-500 animate-pulse`} />
                  )}
                </div>
                <div className={`${caption} flex items-center gap-2`}>
                  {session.state === "stopped" ? (
                    <span className={badgeSmallWarning}>{t("ioSourcePicker.sources.stopped")}</span>
                  ) : session.state === "paused" && session.sourceType === "capture" ? (
                    <span className={badgeSmallInfo}>{t("ioSourcePicker.sources.paused")}</span>
                  ) : session.sourceType === "capture" ? (
                    <span className={badgeSmallInfo}>{t("ioSourcePicker.sources.playing")}</span>
                  ) : (
                    <span className={badgeSmallSuccess}>{t("ioSourcePicker.sources.live")}</span>
                  )}
                  <span>{info.subtitle}</span>
                  {session.captureId && (
                    <>
                      <span className="text-[color:var(--text-muted)]">·</span>
                      <span className="text-[color:var(--text-cyan)]">
                        {t("ioSourcePicker.sources.framesCount", { count: session.captureFrameCount?.toLocaleString() ?? "?" })}
                      </span>
                    </>
                  )}
                </div>
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
  );

  return (
    <div className={borderDivider}>
      {/* Tabs (only when more than one tab is relevant) */}
      {tabDefs.length > 1 && (
        <SourceTabs tabs={tabDefs} activeTab={effectiveTab} onTabChange={onTabChange} />
      )}

      {/* Tab body — collapsed selected-source card, or the active tab's list */}
      {showCollapsed
        ? renderCollapsedSource()
        : effectiveTab === "sessions"
        ? sessionsBody
        : effectiveTab === "captures"
        ? capturesBody
        : devicesBody}

      {readProfiles.length === 0 && !isCsvSelected && (
        <div className="p-4 text-sm text-[color:var(--text-muted)]">
          {t("ioSourcePicker.sources.noSources")}
        </div>
      )}
    </div>
  );
}

// Helper component for reader buttons
function SourceButton({
  profile,
  isChecked,
  isDefault,
  isLoading,
  isLive,
  sessionState,
  onSelect,
  useCheckbox = false,
  busNumber,
  isDisabled = false,
  disabledReason,
  usageInfo,
  isRealtime = false,
}: {
  profile: IOProfile;
  isChecked: boolean;
  isDefault: boolean;
  isLoading: boolean;
  isLive: boolean;
  sessionState?: string;
  onSelect: (sourceId: string | null) => void;
  useCheckbox?: boolean;
  busNumber?: number;
  isDisabled?: boolean;
  disabledReason?: string;
  usageInfo?: ProfileUsageInfo;
  isRealtime?: boolean;
}) {
  const { t } = useTranslation("dialogs");
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
          : isLoading
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
      onClick={isDisabled || isLoading ? undefined : () => onSelect(isChecked && !useCheckbox ? null : profile.id)}
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
              {t("ioSourcePicker.sources.busLabel", { bus: busNumber })}
            </span>
          )}
          {isLive && !isDisabled && (
            isStopped ? (
              <span className={badgeSmallWarning}>{t("ioSourcePicker.sources.stopped")}</span>
            ) : isRunning ? (
              <span className={badgeSmallSuccess}>{t("ioSourcePicker.sources.live")}</span>
            ) : (
              <span className={badgeSmallSuccess}>{t("ioSourcePicker.sources.active")}</span>
            )
          )}
        </div>
        <div className={`text-xs ${isDisabled ? "text-[color:var(--text-muted)]" : "text-[color:var(--text-muted)]"}`}>
          {isDisabled && disabledReason ? (
            <span>{profile.kind} · <span className="text-[color:var(--text-muted)]">{disabledReason}</span></span>
          ) : usageInfo && usageInfo.sessionCount > 0 ? (
            <span className="flex items-center gap-1.5">
              <span>{profile.kind}</span>
              {usageInfo.configLocked && (
                <span title={t("ioSourcePicker.sources.configLocked")}>
                  <Lock className={`${iconXs} text-[color:var(--text-amber)]`} />
                </span>
              )}
              {usageInfo.sessionIds.slice(0, 2).map((sid) => (
                <span key={sid} className={isRealtime ? badgeSmallPurple : badgeSmallSuccess}>
                  {sid}
                </span>
              ))}
              {usageInfo.sessionCount > 2 && (
                <span className="text-[color:var(--text-muted)]">+{usageInfo.sessionCount - 2}</span>
              )}
            </span>
          ) : (
            profile.kind
          )}
        </div>
      </div>
    </div>
  );
}
