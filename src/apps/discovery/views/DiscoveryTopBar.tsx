// ui/src/apps/discovery/views/DiscoveryTopBar.tsx

import { Search, ChevronRight, Save, Trash2, Info, Wrench, Download, Undo2 } from "lucide-react";
import type { IOProfile } from "../../../types/common";
import type { BufferMetadata } from "../../../api/buffer";
import AppTopBar from "../../../components/AppTopBar";
import { buttonBase, iconButtonBase } from "../../../styles/buttonStyles";
import { iconMd, iconSm } from "../../../styles/spacing";

type Props = {
  // IO profile selection
  ioProfiles: IOProfile[];
  ioProfile: string | null;
  onIoProfileChange: (id: string | null) => void;
  defaultReadProfileId?: string | null;
  bufferMetadata?: BufferMetadata | null;
  isStreaming: boolean;
  /** Whether multi-bus mode is active */
  multiBusMode?: boolean;
  /** Profile IDs when in multi-bus mode */
  multiBusProfiles?: string[];

  // Stop control (Watch is initiated via data source dialog)
  onStopWatch?: () => void;
  /** Whether the session is stopped (not streaming) but has a profile selected */
  isStopped?: boolean;
  /** Called when user wants to resume a stopped session */
  onResume?: () => void;
  /** Number of apps connected to this session (for Detach button) */
  joinerCount?: number;
  /** Called when user wants to detach from shared session without stopping */
  onDetach?: () => void;
  /** Whether we've detached from the session but still have profile selected */
  isDetached?: boolean;
  /** Called when user wants to rejoin after detaching */
  onRejoin?: () => void;
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
  selectedFrameCount: number;
  onOpenFramePicker: () => void;

  // Serial mode state
  isSerialMode?: boolean;
  serialBytesCount?: number;
  /** True when framing has been accepted in serial mode */
  framingAccepted?: boolean;
  /** Active tab in serial mode: 'raw', 'framed', 'filtered', or 'analysis' */
  serialActiveTab?: 'raw' | 'framed' | 'filtered' | 'analysis';
  /** Called when user wants to undo framing acceptance */
  onUndoFraming?: () => void;

  // Dialogs
  onOpenIoReaderPicker: () => void;

  // Actions
  onSave: () => void;
  onExport: () => void;
  onClear: () => void;
  onInfo: () => void;
  onOpenToolbox: () => void;
};

export default function DiscoveryTopBar({
  ioProfiles,
  ioProfile,
  defaultReadProfileId,
  bufferMetadata,
  isStreaming,
  multiBusMode = false,
  multiBusProfiles = [],
  onStopWatch,
  isStopped = false,
  onResume,
  joinerCount = 1,
  onDetach,
  isDetached = false,
  onRejoin,
  frameCount,
  selectedFrameCount,
  onOpenFramePicker,
  isSerialMode = false,
  serialBytesCount = 0,
  framingAccepted = false,
  serialActiveTab = 'raw',
  onUndoFraming,
  supportsTimeRange = false,
  onOpenBookmarkPicker,
  speed = 1,
  supportsSpeed = false,
  onOpenSpeedPicker,
  onOpenIoReaderPicker,
  onSave,
  onExport,
  onClear,
  onInfo,
  onOpenToolbox,
}: Props) {
  // In serial mode, tools are available with raw bytes even without framed data
  const hasFrames = isSerialMode ? (frameCount > 0 || serialBytesCount > 0) : frameCount > 0;

  return (
    <AppTopBar
      icon={Search}
      iconColour="text-[color:var(--text-purple)]"
      ioSession={{
        ioProfile,
        ioProfiles,
        multiBusMode,
        multiBusProfiles,
        bufferMetadata,
        defaultReadProfileId,
        onOpenIoReaderPicker,
        speed,
        supportsSpeed,
        onOpenSpeedPicker,
        isStreaming,
        isStopped,
        isDetached,
        joinerCount,
        supportsTimeRange,
        onStop: onStopWatch,
        onResume,
        onDetach,
        onRejoin,
        onOpenBookmarkPicker,
      }}
      framePicker={{
        frameCount,
        selectedCount: selectedFrameCount,
        onOpen: onOpenFramePicker,
        disabled: isSerialMode && !framingAccepted,
        disabledTitle: "Accept framing first to select frames",
      }}
      actions={
        <>
          <button
            onClick={onSave}
            disabled={!hasFrames}
            className={iconButtonBase}
            title={isSerialMode ? "Save bytes to decoder" : "Save frames to decoder"}
          >
            <Save className={iconMd} />
          </button>

          <button
            onClick={onExport}
            disabled={!hasFrames}
            className={iconButtonBase}
            title={isSerialMode && serialActiveTab === 'raw' ? "Export bytes to file" : "Export frames to file"}
          >
            <Download className={iconMd} />
          </button>

          <button
            onClick={onClear}
            disabled={!hasFrames}
            className={`${iconButtonBase} hover:!bg-red-600 hover:!text-white`}
            title={isSerialMode ? "Clear all bytes" : "Clear all frames"}
          >
            <Trash2 className={iconMd} />
          </button>

          <button
            onClick={onInfo}
            disabled={!hasFrames}
            className={`${iconButtonBase} ${hasFrames ? "text-[color:var(--text-purple)]" : ""}`}
            title="View decoder knowledge"
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
          title="Undo framing acceptance"
        >
          <Undo2 className={iconMd} />
        </button>
      )}

      {/* Right arrow icon */}
      <ChevronRight className={`${iconSm} text-slate-400 shrink-0`} />

      {/* Toolbox button */}
      <button
        onClick={onOpenToolbox}
        disabled={!hasFrames}
        className={buttonBase}
        title="Analysis tools"
      >
        <Wrench className={`${iconSm} flex-shrink-0`} />
        <span>Tools</span>
      </button>
    </AppTopBar>
  );
}
