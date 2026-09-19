// ui/src/dialogs/io-source-picker/ActionButtons.tsx

import { useTranslation } from "react-i18next";
import { Download, Loader2, Upload, Check, Plug, Play, GitMerge, Unplug, RotateCcw } from "lucide-react";
import type { IOProfile } from "../../hooks/useSettings";
import { CSV_EXTERNAL_ID, isRealtimeProfile } from "./utils";
import { isCaptureProfileId } from "../../hooks/useIOSessionManager";
import { panelFooter } from "../../styles";
import { iconMd, iconSm } from "../../styles/spacing";
import { Button } from "../../components/Button";
import { SuccessButton, PrimaryButton } from "../../components/forms";
import { Alert } from "../../components/Alert";

type Props = {
  /** Dialog mode: "streaming" shows Connect/Load, "connect" shows just Connect */
  mode?: "streaming" | "connect";
  isLoading: boolean;
  loadProfileId: string | null;
  checkedSourceId: string | null;
  checkedProfile: IOProfile | null;
  isCaptureSelected: boolean;
  /** Whether the checked profile has an active session (is "live") */
  isCheckedProfileLive?: boolean;
  /** Whether the checked profile's session is stopped (but still exists) */
  isCheckedProfileStopped?: boolean;
  // CSV import
  isImporting: boolean;
  importError: string | null;
  onImport: () => void;
  // Actions
  onLoadClick: () => void;
  onConnectClick?: () => void;
  /** Called when user wants to join an existing live session */
  onJoinClick?: () => void;
  /** Called when user wants to start a stopped session */
  onStartClick?: () => void;
  onClose: () => void;
  /** Called when user wants to continue without selecting a source */
  onSkip?: () => void;
  // Multi-select mode
  /** Whether multi-select mode is active */
  multiSelectMode?: boolean;
  /** Number of profiles selected in multi-select mode */
  multiSelectCount?: number;
  /** Called when user wants to watch multiple profiles (multi-bus mode) */
  onMultiConnectClick?: () => void;
  /** Called when user wants to release/reset the dialog state */
  onRelease?: () => void;
  /** Called when user wants to restart a live session with updated config */
  onRestartClick?: () => void;
  /** Whether there's a live multi-source session for the selected profiles */
  isMultiSourceLive?: boolean;
  /** Called when user wants to restart a live multi-source session with updated config */
  onMultiRestartClick?: () => void;
  /** Called when user clicks Connect in connect mode (creates session without streaming) */
  onConnectOnlyClick?: () => void;
  /** Called when user clicks Connect for a buffer source (with bus mappings) */
  onCaptureConnectClick?: () => void;
};

export default function ActionButtons({
  mode = "streaming",
  isLoading,
  loadProfileId,
  checkedSourceId,
  checkedProfile,
  isCaptureSelected,
  isCheckedProfileLive,
  isCheckedProfileStopped,
  isImporting,
  importError,
  onImport,
  onLoadClick,
  onConnectClick,
  onJoinClick,
  onStartClick,
  onClose,
  onSkip,
  multiSelectMode = false,
  multiSelectCount = 0,
  onMultiConnectClick,
  onRelease,
  onRestartClick,
  isMultiSourceLive = false,
  onMultiRestartClick,
  onConnectOnlyClick,
  onCaptureConnectClick,
}: Props) {
  const { t } = useTranslation("dialogs");
  const isCsvSelected = checkedSourceId === CSV_EXTERNAL_ID;
  const isCheckedRealtime = checkedProfile ? isRealtimeProfile(checkedProfile) : false;

  // Show release button when there's a selection that can be released
  const hasSelection = checkedSourceId !== null || isCaptureSelected || (multiSelectMode && multiSelectCount > 0);
  const showRelease = onRelease && hasSelection && !isLoading;

  // Leave button component for inline use - red button that leaves the session
  const releaseButton = showRelease ? (
    <Button
      onClick={onRelease}
      variant="solid"
      tone="danger"
      title={t("ioSourcePicker.actions.leaveTooltip")}
    >
      <Unplug className={iconSm} />
      {t("ioSourcePicker.actions.leave")}
    </Button>
  ) : null;

  return (
    <div className={panelFooter}>
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 text-sm text-[color:var(--text-muted)]">
          <Loader2 className={`${iconMd} animate-spin`} />
          <span>{t("ioSourcePicker.actions.loadingFrom", { profile: loadProfileId })}</span>
        </div>
      ) : multiSelectMode ? (
        // Multi-select mode - show Multi-Bus Watch/Restart buttons
        multiSelectCount > 0 && onMultiConnectClick ? (
          <div className="flex gap-2">
            <SuccessButton
              onClick={onMultiConnectClick}
              className="flex-1"
            >
              <GitMerge className={iconMd} />
              <span>{t("ioSourcePicker.actions.connect")}</span>
            </SuccessButton>
            {isMultiSourceLive && onMultiRestartClick && (
              <PrimaryButton
                onClick={onMultiRestartClick}
                className="flex-1"
                title={t("ioSourcePicker.actions.restartTooltip")}
              >
                <RotateCcw className={iconMd} />
                <span>{t("ioSourcePicker.actions.restart")}</span>
              </PrimaryButton>
            )}
          </div>
        ) : (
          <div className="text-center text-sm text-[color:var(--text-muted)] py-1">
            {t("ioSourcePicker.actions.selectRealtime")}
          </div>
        )
      ) : isCsvSelected ? (
        // CSV selected - show Import button
        <div className="space-y-2">
          <div className="flex gap-2">
            <PrimaryButton
              onClick={onImport}
              disabled={isImporting}
              className="flex-1"
            >
              {isImporting ? (
                <>
                  <Loader2 className={`${iconMd} animate-spin`} />
                  <span>{t("ioSourcePicker.actions.importing")}</span>
                </>
              ) : (
                <>
                  <Upload className={iconMd} />
                  <span>{t("ioSourcePicker.actions.import")}</span>
                </>
              )}
            </PrimaryButton>
            {releaseButton}
          </div>
          {importError && (
            <Alert tone="danger" size="sm">
              {importError}
            </Alert>
          )}
        </div>
      ) : mode === "connect" && checkedSourceId ? (
        // Connect mode - show single Connect button (for Query app)
        // Uses onConnectOnlyClick if provided (creates session without streaming), falls back to onConnectClick
        <div className="flex gap-2">
          <SuccessButton
            onClick={onConnectOnlyClick ?? onConnectClick}
            className="flex-1"
          >
            <Plug className={iconMd} />
            <span>{t("ioSourcePicker.actions.connect")}</span>
          </SuccessButton>
          {releaseButton}
        </div>
      ) : checkedSourceId && isCaptureProfileId(checkedSourceId) ? (
        // Buffer source selected — show Connect (with bus mappings)
        <div className="flex gap-2">
          <SuccessButton
            onClick={onCaptureConnectClick ?? onJoinClick ?? onClose}
            className="flex-1"
          >
            <Plug className={iconMd} />
            <span>{t("ioSourcePicker.actions.connect")}</span>
          </SuccessButton>
          {releaseButton}
        </div>
      ) : checkedSourceId ? (
        // IO source selected - show action buttons based on session state
        isCheckedProfileLive && !isCheckedProfileStopped && onJoinClick ? (
          // Profile has a running session - show Join + Restart buttons
          <div className="flex gap-2">
            <SuccessButton
              onClick={onJoinClick}
              className="flex-1"
            >
              <Plug className={iconMd} />
              <span>{t("ioSourcePicker.actions.join")}</span>
            </SuccessButton>
            {onRestartClick && (
              <PrimaryButton
                onClick={onRestartClick}
                className="flex-1"
                title={t("ioSourcePicker.actions.restartTooltip")}
              >
                <RotateCcw className={iconMd} />
                <span>{t("ioSourcePicker.actions.restart")}</span>
              </PrimaryButton>
            )}
          </div>
        ) : isCheckedProfileStopped && onStartClick ? (
          // Profile has a stopped session - show Resume (which also joins) + Watch/Ingest (reinitialize)
          <div className="space-y-2">
            {/* Row 1: Resume restarts and joins the session */}
            <div className="flex gap-2">
              <SuccessButton
                onClick={onStartClick}
                className="flex-1"
              >
                <Play className={iconMd} />
                <span>{t("ioSourcePicker.actions.resumeJoin")}</span>
              </SuccessButton>
              {releaseButton}
            </div>
            {/* Row 2: Connect/Load to reinitialize with new options */}
            <div className="flex gap-2">
              {!isCheckedRealtime && (
                <PrimaryButton
                  onClick={onLoadClick}
                  className="flex-1"
                >
                  <Download className={iconMd} />
                  <span>{t("ioSourcePicker.actions.load")}</span>
                </PrimaryButton>
              )}
              <PrimaryButton
                onClick={onConnectClick}
                className="flex-1"
              >
                <Plug className={iconMd} />
                <span>{t("ioSourcePicker.actions.connect")}</span>
              </PrimaryButton>
            </div>
          </div>
        ) : (
          // No session exists - show Connect/Load to create new session
          <div className="flex gap-2">
            {!isCheckedRealtime && (
              <SuccessButton
                onClick={onLoadClick}
                className="flex-1"
              >
                <Download className={iconMd} />
                <span>{t("ioSourcePicker.actions.load")}</span>
              </SuccessButton>
            )}
            <PrimaryButton
              onClick={onConnectClick}
              className="flex-1"
            >
              <Plug className={iconMd} />
              <span>{t("ioSourcePicker.actions.connect")}</span>
            </PrimaryButton>
            {releaseButton}
          </div>
        )
      ) : isCaptureSelected ? (
        // Buffer is selected - show Connect if bus mapping available, otherwise OK
        <div className="flex gap-2">
          <Button
            onClick={onCaptureConnectClick ?? onClose}
            variant="solid"
            tone={onCaptureConnectClick ? "success" : "primary"}
            size="lg"
            className="flex-1"
          >
            {onCaptureConnectClick ? <Plug className={iconMd} /> : <Check className={iconMd} />}
            <span>{onCaptureConnectClick ? t("ioSourcePicker.actions.connect") : t("ioSourcePicker.actions.ok")}</span>
          </Button>
          {releaseButton}
        </div>
      ) : onSkip ? (
        // Nothing selected but skip is available
        <PrimaryButton
          onClick={onSkip}
          className="w-full"
        >
          <span>{t("ioSourcePicker.actions.continueWithoutSource")}</span>
        </PrimaryButton>
      ) : (
        <div className="text-center text-sm text-[color:var(--text-muted)] py-1">
          {mode === "connect" ? t("ioSourcePicker.actions.selectDatabase") : t("ioSourcePicker.actions.selectSource")}
        </div>
      )}
    </div>
  );
}
