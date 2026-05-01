// ui/src/apps/discovery/views/DiscoveryTopBar.tsx

import { Search, ChevronRight, Save, Info, Wrench, Download, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { IOProfile } from "../../../types/common";
import type { CaptureMetadata } from "../../../api/capture";
import type { BusSourceInfo } from "../../../utils/busFormat";
import AppTopBar from "../../../components/AppTopBar";
import { buttonBase, iconButtonBase } from "../../../styles/buttonStyles";
import { iconMd, iconSm } from "../../../styles/spacing";

type Props = {
  // IO profile selection
  ioProfiles: IOProfile[];
  ioProfile: string | null;
  onIoProfileChange: (id: string | null) => void;
  defaultReadProfileId?: string | null;
  captureMetadata?: CaptureMetadata | null;
  /** Current session ID (e.g., "f_abc123") */
  sessionId?: string | null;
  isStreaming: boolean;
  /** Whether the session is paused */
  isPaused?: boolean;
  /** Profile IDs when in multi-bus mode */
  multiBusProfiles?: string[];
  /** Current IO state (running, stopped, paused, error) */
  ioState?: string | null;
  /** Bus-to-source mapping for tooltip display */
  outputBusToSource?: Map<number, BusSourceInfo>;

  // Session controls
  /** Whether the session is stopped (not streaming) but has a profile selected */
  isStopped?: boolean;
  /** Play/resume the session */
  onPlay?: () => void;
  /** Pause the session */
  onPause?: () => void;
  /** Called when user wants to leave session */
  onLeave?: () => void;
  /** Whether the IO source supports time range filtering */
  supportsTimeRange?: boolean;
  /** Called to open bookmark picker */
  onOpenBookmarkPicker?: () => void;

  // Speed control
  /** Current playback speed */
  speed?: number;
  /** Whether the reader supports speed control */
  supportsSpeed?: boolean;
  /** Called to open speed picker */
  onOpenSpeedPicker?: () => void;

  // Frame picker
  frameCount: number;
  /** Unique frame IDs seen at the session level (for tooltip) */
  uniqueFrameCount?: number;
  /** Total frames seen at the session level (for tooltip) */
  totalFrameCount?: number;
  selectedFrameCount: number;
  onOpenFramePicker: () => void;

  // Serial mode state
  isSerialMode?: boolean;
  serialBytesCount?: number;
  /** True when framing has been accepted in serial mode */
  framingAccepted?: boolean;
  /** Active tab in serial mode */
  serialActiveTab?: string;
  /** Called when user wants to undo framing acceptance */
  onUndoFraming?: () => void;

  /** Whether the active profile is Modbus TCP (enables scan tools without data) */
  isModbusProfile?: boolean;

  // Buffer actions
  /** Whether the session is in buffer replay mode */
  isCaptureMode?: boolean;
  /** Whether the current buffer is persistent (pinned) */
  capturePersistent?: boolean;
  /** Called when user toggles buffer pin */
  onToggleCapturePin?: () => void;
  /** Called when user renames the buffer */
  onRenameCapture?: (newName: string) => void;
  /** Called when user clicks the clear/trash button (session-level) */
  onClearCapture?: () => void;
  /** Whether the app has data that can be cleared */
  hasData?: boolean;

  // Dialogs
  onOpenIoSessionPicker: () => void;

  // Actions
  onSave: () => void;
  onExport: () => void;
  onInfo: () => void;
  onOpenToolbox: () => void;
};

export default function DiscoveryTopBar({
  ioProfiles,
  ioProfile,
  defaultReadProfileId,
  captureMetadata,
  sessionId,
  isStreaming,
  isPaused = false,
  multiBusProfiles = [],
  ioState,
  outputBusToSource,
  isStopped = false,
  onPlay,
  onPause,
  onLeave,
  frameCount,
  uniqueFrameCount,
  totalFrameCount,
  selectedFrameCount,
  onOpenFramePicker,
  isSerialMode = false,
  serialBytesCount = 0,
  framingAccepted = false,
  serialActiveTab = 'raw',
  onUndoFraming,
  isModbusProfile = false,
  isCaptureMode = false,
  capturePersistent = false,
  onToggleCapturePin,
  onRenameCapture,
  onClearCapture,
  hasData = false,
  supportsTimeRange = false,
  onOpenBookmarkPicker,
  speed = 1,
  supportsSpeed = false,
  onOpenSpeedPicker,
  onOpenIoSessionPicker,
  onSave,
  onExport,
  onInfo,
  onOpenToolbox,
}: Props) {
  const { t } = useTranslation("discovery");
  // In serial mode, tools are available with raw bytes even without framed data
  const hasFrames = isSerialMode ? (frameCount > 0 || serialBytesCount > 0) : frameCount > 0;

  return (
    <AppTopBar
      icon={Search}
      iconColour="text-[color:var(--text-purple)]"
      ioSession={{
        ioProfile,
        ioProfiles,
        multiBusProfiles,
        captureMetadata,
        defaultReadProfileId,
        sessionId,
        ioState,
        frameCount: uniqueFrameCount,
        totalFrameCount,
        outputBusToSource,
        onOpenIoSessionPicker,
        speed,
        supportsSpeed,
        onOpenSpeedPicker,
        isStreaming,
        isPaused,
        isStopped,
        supportsTimeRange,
        onPlay,
        onPause,
        onLeave,
        onOpenBookmarkPicker,
        isCaptureMode,
        capturePersistent,
        onToggleCapturePin,
        onRenameCapture,
        onClearCapture,
        hasData,
      }}
      framePicker={{
        frameCount,
        selectedCount: selectedFrameCount,
        onOpen: onOpenFramePicker,
        disabled: isSerialMode && !framingAccepted,
        disabledTitle: t("topBar.framePickerDisabled"),
      }}
      actions={
        <>
          <button
            onClick={onSave}
            disabled={!hasFrames}
            className={iconButtonBase}
            title={isSerialMode ? t("topBar.saveBytes") : t("topBar.saveFrames")}
          >
            <Save className={iconMd} />
          </button>

          <button
            onClick={onExport}
            disabled={!hasFrames}
            className={iconButtonBase}
            title={isSerialMode && serialActiveTab === 'raw' ? t("topBar.exportBytes") : t("topBar.exportFrames")}
          >
            <Download className={iconMd} />
          </button>

          <button
            onClick={onInfo}
            disabled={!hasFrames}
            className={`${iconButtonBase} ${hasFrames ? "text-[color:var(--text-purple)]" : ""}`}
            title={t("topBar.decoderKnowledge")}
          >
            <Info className={iconMd} />
          </button>
        </>
      }
    >
      {/* Undo Framing button - shows in serial mode when framing is accepted */}
      {isSerialMode && framingAccepted && onUndoFraming && (
        <button
          onClick={onUndoFraming}
          className={iconButtonBase}
          title={t("topBar.undoFraming")}
        >
          <Undo2 className={iconMd} />
        </button>
      )}

      {/* Right arrow icon */}
      <ChevronRight className={`${iconSm} text-slate-400 shrink-0`} />

      {/* Toolbox button */}
      <button
        onClick={onOpenToolbox}
        disabled={!hasFrames && !isModbusProfile}
        className={buttonBase}
        title={isModbusProfile ? t("topBar.scanningTools") : t("topBar.analysisTools")}
      >
        <Wrench className={`${iconSm} flex-shrink-0`} />
        <span>{t("topBar.toolsLabel")}</span>
      </button>
    </AppTopBar>
  );
}
