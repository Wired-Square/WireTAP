// ui/src/dialogs/io-reader-picker/ActionButtons.tsx

import { Download, Eye, Loader2, Upload, Check, Plug, Play, GitMerge } from "lucide-react";
import type { IOProfile } from "../../hooks/useSettings";
import { CSV_EXTERNAL_ID, isRealtimeProfile } from "./utils";
import { primaryButtonBase, successButtonBase, panelFooter, errorBoxCompact } from "../../styles";

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
}: Props) {
  const isCsvSelected = checkedReaderId === CSV_EXTERNAL_ID;
  const isCheckedRealtime = checkedProfile ? isRealtimeProfile(checkedProfile) : false;

  return (
    <div className={panelFooter}>
      {isIngesting ? (
        <div className="flex items-center justify-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Ingesting from {ingestProfileId}...</span>
        </div>
      ) : multiSelectMode ? (
        // Multi-select mode - show Multi-Bus Watch button
        multiSelectCount > 0 && onMultiWatchClick ? (
          <button
            onClick={onMultiWatchClick}
            className={`w-full ${successButtonBase}`}
          >
            <GitMerge className="w-4 h-4" />
            <span>Watch {multiSelectCount} Buses</span>
          </button>
        ) : (
          <div className="text-center text-sm text-slate-400 dark:text-slate-500 py-1">
            Select real-time readers to watch
          </div>
        )
      ) : isCsvSelected ? (
        // CSV selected - show Import button
        <div className="space-y-2">
          <button
            onClick={onImport}
            disabled={isImporting}
            className={`w-full ${primaryButtonBase}`}
          >
            {isImporting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Importing...</span>
              </>
            ) : (
              <>
                <Upload className="w-4 h-4" />
                <span>Import</span>
              </>
            )}
          </button>
          {importError && (
            <div className={errorBoxCompact}>
              {importError}
            </div>
          )}
        </div>
      ) : checkedReaderId ? (
        // IO reader selected - show action buttons based on session state
        isCheckedProfileLive && !isCheckedProfileStopped && onJoinClick ? (
          // Profile has a running session - show Join button only
          <button
            onClick={onJoinClick}
            className={`w-full ${successButtonBase}`}
          >
            <Plug className="w-4 h-4" />
            <span>Join Session</span>
          </button>
        ) : isCheckedProfileStopped && onStartClick ? (
          // Profile has a stopped session - show Resume (which also joins) + Watch/Ingest (reinitialize)
          <div className="space-y-2">
            {/* Row 1: Resume restarts and joins the session */}
            <button
              onClick={onStartClick}
              className={`w-full ${successButtonBase}`}
            >
              <Play className="w-4 h-4" />
              <span>Resume and Join</span>
            </button>
            {/* Row 2: Watch/Ingest to reinitialize with new options */}
            <div className="flex gap-2">
              {!isCheckedRealtime && (
                <button
                  onClick={onIngestClick}
                  className={`flex-1 ${primaryButtonBase}`}
                >
                  <Download className="w-4 h-4" />
                  <span>Ingest</span>
                </button>
              )}
              <button
                onClick={onWatchClick}
                className={`flex-1 ${primaryButtonBase}`}
              >
                <Eye className="w-4 h-4" />
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
                <Download className="w-4 h-4" />
                <span>Ingest</span>
              </button>
            )}
            <button
              onClick={onWatchClick}
              className={`flex-1 ${primaryButtonBase}`}
            >
              <Eye className="w-4 h-4" />
              <span>Watch</span>
            </button>
          </div>
        )
      ) : isBufferSelected ? (
        // Buffer is selected, no IO reader checked - show OK to keep buffer
        <button
          onClick={onClose}
          className={`w-full ${primaryButtonBase}`}
        >
          <Check className="w-4 h-4" />
          <span>OK</span>
        </button>
      ) : onSkip ? (
        // Nothing selected but skip is available
        <button
          onClick={onSkip}
          className={`w-full ${primaryButtonBase}`}
        >
          <span>Continue Without Reader</span>
        </button>
      ) : (
        <div className="text-center text-sm text-slate-400 dark:text-slate-500 py-1">
          Select an IO reader to continue
        </div>
      )}
    </div>
  );
}
