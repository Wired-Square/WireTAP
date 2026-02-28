// ui/src/apps/discovery/views/DiscoveryTopBar.tsx

import { Search, ChevronRight, Save, Trash2, Info, Wrench, Download, Undo2 } from "lucide-react";
import type { IOProfile } from "../../../types/common";
import type { BufferMetadata } from "../../../api/buffer";
import AppTopBar from "../../../components/AppTopBar";
import { buttonBase, iconButtonBase } from "../../../styles/buttonStyles";
import { isBufferProfileId } from "../../../hooks/useIOSessionManager";
import { iconMd, iconSm } from "../../../styles/spacing";

type Props = {
  // IO profile selection
  ioProfiles: IOProfile[];
  ioProfile: string | null;
  onIoProfileChange: (id: string | null) => void;
  defaultReadProfileId?: string | null;
  bufferMetadata?: BufferMetadata | null;
  /** Current session ID (e.g., "f_abc123") */
  sessionId?: string | null;
  isStreaming: boolean;
  /** Profile IDs when in multi-bus mode */
  multiBusProfiles?: string[];
  /** Current IO state (running, stopped, paused, error) */
  ioState?: string | null;
  /** Whether the session is a realtime source (not buffer replay) */
  isRealtime?: boolean;

  // Stop control (Watch is initiated via data source dialog)
  onStopWatch?: () => void;
  /** Whether the session is stopped (not streaming) but has a profile selected */
  isStopped?: boolean;
  /** Called when user wants to resume a stopped session */
  onResume?: () => void;
  /** Called when user wants to leave session (session continues running) */
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
  sessionId,
  isStreaming,
  multiBusProfiles = [],
  ioState,
  isRealtime: _isRealtime = true,
  onStopWatch,
  isStopped = false,
  onResume,
  onLeave,
  frameCount,
  selectedFrameCount,
  onOpenFramePicker,
  isSerialMode = false,
  serialBytesCount = 0,
  framingAccepted = false,
  serialActiveTab = 'raw',
  onUndoFraming,
  isModbusProfile = false,
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
        multiBusProfiles,
        bufferMetadata,
        defaultReadProfileId,
        sessionId,
        ioState,
        onOpenIoReaderPicker,
        speed,
        supportsSpeed,
        onOpenSpeedPicker,
        isStreaming,
        isStopped, // Show Resume in both realtime and buffer mode (to return to live)
        supportsTimeRange,
        onStop: !isBufferProfileId(ioProfile) ? onStopWatch : undefined, // Hide Stop only in buffer mode
        onResume, // Always show Resume when stopped (resumeFresh handles live return)
        onLeave,
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
        disabled={!hasFrames && !isModbusProfile}
        className={buttonBase}
        title={isModbusProfile ? "Scanning & analysis tools" : "Analysis tools"}
      >
        <Wrench className={`${iconSm} flex-shrink-0`} />
        <span>Tools</span>
      </button>
    </AppTopBar>
  );
}
