// ui/src/dialogs/io-reader-picker/ActionButtons.tsx

import { Download, Eye, Loader2, Upload, Check, Plug, Play, GitMerge, Unplug, RotateCcw } from "lucide-react";
import type { IOProfile } from "../../hooks/useSettings";
import { CSV_EXTERNAL_ID, isRealtimeProfile } from "./utils";
import { primaryButtonBase, successButtonBase, panelFooter, errorBoxCompact, dangerButtonBase } from "../../styles";
import { iconMd, iconSm } from "../../styles/spacing";

type Props = {
  isIngesting: boolean;
  ingestProfileId: string | null;
  checkedReaderId: string | null;
  checkedProfile: IOProfile | null;
  isBufferSelected: boolean;
  /** Whether the checked profile has an active session (is "live") */
  isCheckedProfileLive?: boolean;
  /** Whether the checked profile's session is stopped (but still exists) */
  isCheckedProfileStopped?: boolean;
  // CSV import
  isImporting: boolean;
  importError: string | null;
  onImport: () => void;
  // Actions
  onIngestClick: () => void;
  onWatchClick: () => void;
  /** Called when user wants to join an existing live session */
  onJoinClick?: () => void;
  /** Called when user wants to start a stopped session */
  onStartClick?: () => void;
  onClose: () => void;
  /** Called when user wants to continue without selecting a reader */
  onSkip?: () => void;
  // Multi-select mode
  /** Whether multi-select mode is active */
  multiSelectMode?: boolean;
  /** Number of profiles selected in multi-select mode */
  multiSelectCount?: number;
  /** Called when user wants to watch multiple profiles (multi-bus mode) */
  onMultiWatchClick?: () => void;
  /** Called when user wants to release/reset the dialog state */
  onRelease?: () => void;
  /** Called when user wants to restart a live session with updated config */
  onRestartClick?: () => void;
  /** Whether there's a live multi-source session for the selected profiles */
  isMultiSourceLive?: boolean;
  /** Called when user wants to restart a live multi-source session with updated config */
  onMultiRestartClick?: () => void;
};

export default function ActionButtons({
  isIngesting,
  ingestProfileId,
  checkedReaderId,
  checkedProfile,
  isBufferSelected,
  isCheckedProfileLive,
  isCheckedProfileStopped,
  isImporting,
  importError,
  onImport,
  onIngestClick,
  onWatchClick,
  onJoinClick,
  onStartClick,
  onClose,
  onSkip,
  multiSelectMode = false,
  multiSelectCount = 0,
  onMultiWatchClick,
  onRelease,
  onRestartClick,
  isMultiSourceLive = false,
  onMultiRestartClick,
}: Props) {
  const isCsvSelected = checkedReaderId === CSV_EXTERNAL_ID;
  const isCheckedRealtime = checkedProfile ? isRealtimeProfile(checkedProfile) : false;

  // Show release button when there's a selection that can be released
  const hasSelection = checkedReaderId !== null || isBufferSelected || (multiSelectMode && multiSelectCount > 0);
  const showRelease = onRelease && hasSelection && !isIngesting;

  // Leave button component for inline use - red button that leaves the session
  const releaseButton = showRelease ? (
    <button
      onClick={onRelease}
      className={`${dangerButtonBase} gap-1.5`}
      title="Leave session and reset selection"
    >
      <Unplug className={iconSm} />
      <span>Leave</span>
    </button>
  ) : null;

  return (
    <div className={panelFooter}>
      {isIngesting ? (
        <div className="flex items-center justify-center gap-2 text-sm text-[color:var(--text-muted)]">
          <Loader2 className={`${iconMd} animate-spin`} />
          <span>Ingesting from {ingestProfileId}...</span>
        </div>
      ) : multiSelectMode ? (
        // Multi-select mode - show Multi-Bus Watch/Restart buttons
        multiSelectCount > 0 && onMultiWatchClick ? (
          <div className="flex gap-2">
            <button
              onClick={onMultiWatchClick}
              className={`flex-1 ${successButtonBase}`}
            >
              <GitMerge className={iconMd} />
              <span>Watch</span>
            </button>
            {isMultiSourceLive && onMultiRestartClick && (
              <button
                onClick={onMultiRestartClick}
                className={`flex-1 ${primaryButtonBase}`}
                title="Restart session with updated configuration"
              >
                <RotateCcw className={iconMd} />
                <span>Restart</span>
              </button>
            )}
          </div>
        ) : (
          <div className="text-center text-sm text-[color:var(--text-muted)] py-1">
            Select real-time readers to watch
          </div>
        )
      ) : isCsvSelected ? (
        // CSV selected - show Import button
        <div className="space-y-2">
          <div className="flex gap-2">
            <button
              onClick={onImport}
              disabled={isImporting}
              className={`flex-1 ${primaryButtonBase}`}
            >
              {isImporting ? (
                <>
                  <Loader2 className={`${iconMd} animate-spin`} />
                  <span>Importing...</span>
                </>
              ) : (
                <>
                  <Upload className={iconMd} />
                  <span>Import</span>
                </>
              )}
            </button>
            {releaseButton}
          </div>
          {importError && (
            <div className={errorBoxCompact}>
              {importError}
            </div>
          )}
        </div>
      ) : checkedReaderId ? (
        // IO reader selected - show action buttons based on session state
        isCheckedProfileLive && !isCheckedProfileStopped && onJoinClick ? (
          // Profile has a running session - show Join + Restart buttons
          <div className="flex gap-2">
            <button
              onClick={onJoinClick}
              className={`flex-1 ${successButtonBase}`}
            >
              <Plug className={iconMd} />
              <span>Join</span>
            </button>
            {onRestartClick && (
              <button
                onClick={onRestartClick}
                className={`flex-1 ${primaryButtonBase}`}
                title="Restart session with updated configuration"
              >
                <RotateCcw className={iconMd} />
                <span>Restart</span>
              </button>
            )}
          </div>
        ) : isCheckedProfileStopped && onStartClick ? (
          // Profile has a stopped session - show Resume (which also joins) + Watch/Ingest (reinitialize)
          <div className="space-y-2">
            {/* Row 1: Resume restarts and joins the session */}
            <div className="flex gap-2">
              <button
                onClick={onStartClick}
                className={`flex-1 ${successButtonBase}`}
              >
                <Play className={iconMd} />
                <span>Resume and Join</span>
              </button>
              {releaseButton}
            </div>
            {/* Row 2: Watch/Ingest to reinitialize with new options */}
            <div className="flex gap-2">
              {!isCheckedRealtime && (
                <button
                  onClick={onIngestClick}
                  className={`flex-1 ${primaryButtonBase}`}
                >
                  <Download className={iconMd} />
                  <span>Ingest</span>
                </button>
              )}
              <button
                onClick={onWatchClick}
                className={`flex-1 ${primaryButtonBase}`}
              >
                <Eye className={iconMd} />
                <span>Watch</span>
              </button>
            </div>
          </div>
        ) : (
          // No session exists - show Watch/Ingest to create new session
          <div className="flex gap-2">
            {!isCheckedRealtime && (
              <button
                onClick={onIngestClick}
                className={`flex-1 ${successButtonBase}`}
              >
                <Download className={iconMd} />
                <span>Ingest</span>
              </button>
            )}
            <button
              onClick={onWatchClick}
              className={`flex-1 ${primaryButtonBase}`}
            >
              <Eye className={iconMd} />
              <span>Watch</span>
            </button>
            {releaseButton}
          </div>
        )
      ) : isBufferSelected ? (
        // Buffer is selected, no IO reader checked - show OK to keep buffer
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className={`flex-1 ${primaryButtonBase}`}
          >
            <Check className={iconMd} />
            <span>OK</span>
          </button>
          {releaseButton}
        </div>
      ) : onSkip ? (
        // Nothing selected but skip is available
        <button
          onClick={onSkip}
          className={`w-full ${primaryButtonBase}`}
        >
          <span>Continue Without Reader</span>
        </button>
      ) : (
        <div className="text-center text-sm text-[color:var(--text-muted)] py-1">
          Select an IO reader to continue
        </div>
      )}
    </div>
  );
}
