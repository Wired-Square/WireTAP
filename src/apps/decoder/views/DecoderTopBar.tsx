// ui/src/apps/decoder/views/DecoderTopBar.tsx

import { Activity, ChevronRight, Star, Glasses, Trash2, Users, User, Filter, Eye, EyeOff, Type } from "lucide-react";
import { iconSm, iconMd } from "../../../styles/spacing";
import type { CatalogMetadata } from "../../../api/catalog";
import type { IOProfile } from "../../../types/common";
import type { PlaybackSpeed } from "../../../components/TimeController";
import type { BufferMetadata } from "../../../api/buffer";
import AppTopBar from "../../../components/AppTopBar";
import { buttonBase, iconButtonBase, toggleButtonClass } from "../../../styles/buttonStyles";

type Props = {
  // Catalog selection
  catalogs: CatalogMetadata[];
  catalogPath: string | null;
  onCatalogChange: (path: string) => void;
  defaultCatalogFilename?: string | null;

  // IO profile selection
  ioProfiles: IOProfile[];
  ioProfile: string | null;
  onIoProfileChange: (id: string | null) => void;
  defaultReadProfileId?: string | null;
  bufferMetadata?: BufferMetadata | null;
  /** Current session ID (e.g., "f_abc123") */
  sessionId?: string | null;
  /** Profile IDs when in multi-bus mode */
  multiBusProfiles?: string[];
  /** Current IO state (running, stopped, paused, error) */
  ioState?: string | null;
  /** Whether the session is a realtime source (not buffer replay) */
  isRealtime?: boolean;

  // Speed (for top bar display, not playback controls)
  speed: PlaybackSpeed;
  supportsSpeed?: boolean;

  // Streaming state (Watch is initiated via data source dialog)
  isStreaming?: boolean;
  onStopStream?: () => void;
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

  // Frame picker
  frameCount: number;
  selectedFrameCount: number;
  onOpenFramePicker: () => void;

  // Dialogs
  onOpenIoReaderPicker: () => void;
  onOpenSpeedPicker: () => void;
  onOpenCatalogPicker: () => void;

  // Raw bytes toggle
  showRawBytes?: boolean;
  onToggleRawBytes?: () => void;

  // Clear decoded values
  onClear?: () => void;

  // View mode toggle (single vs per-source)
  viewMode?: 'single' | 'per-source';
  onToggleViewMode?: () => void;

  // Min frame length filter
  minFrameLength?: number;
  onOpenFilterDialog?: () => void;

  // Hide unseen frames toggle
  hideUnseen?: boolean;
  onToggleHideUnseen?: () => void;

  // ASCII gutter toggle (for unmatched/filtered tabs)
  showAsciiGutter?: boolean;
  onToggleAsciiGutter?: () => void;

  // Frame ID filter (for coloring the filter button when active)
  frameIdFilter?: string;
};

export default function DecoderTopBar({
  catalogs,
  catalogPath,
  defaultCatalogFilename,
  ioProfiles,
  ioProfile,
  defaultReadProfileId,
  bufferMetadata,
  sessionId,
  multiBusProfiles = [],
  ioState,
  isRealtime = true,
  speed,
  supportsSpeed = false,
  isStreaming = false,
  onStopStream,
  isStopped = false,
  onResume,
  onLeave,
  supportsTimeRange = false,
  onOpenBookmarkPicker,
  frameCount,
  selectedFrameCount,
  onOpenFramePicker,
  onOpenIoReaderPicker,
  onOpenSpeedPicker,
  onOpenCatalogPicker,
  showRawBytes = false,
  onToggleRawBytes,
  onClear,
  viewMode = 'single',
  onToggleViewMode,
  minFrameLength = 0,
  onOpenFilterDialog,
  hideUnseen = true,
  onToggleHideUnseen,
  showAsciiGutter = false,
  onToggleAsciiGutter,
  frameIdFilter = '',
}: Props) {
  // Normalise path separators for cross-platform comparison (Windows uses backslashes)
  const normalisePath = (p: string) => p.replace(/\\/g, '/');
  const normalisedCatalogPath = catalogPath ? normalisePath(catalogPath) : null;
  const selectedCatalog = catalogs.find((c) => normalisePath(c.path) === normalisedCatalogPath);
  const hasCatalog = !!selectedCatalog;
  const catalogName = selectedCatalog?.name || "No catalog";
  const isDefaultCatalog = selectedCatalog?.filename === defaultCatalogFilename;

  // Filter button state
  const hasFilters = minFrameLength > 0 || frameIdFilter.trim() !== '';
  const filterParts: string[] = [];
  if (minFrameLength > 0) filterParts.push(`min ${minFrameLength}B`);
  if (frameIdFilter.trim()) filterParts.push(`ID: ${frameIdFilter}`);

  return (
    <AppTopBar
      icon={Activity}
      iconColour="text-[color:var(--text-green)]"
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
        onStop: isRealtime ? onStopStream : undefined, // Hide Stop when in buffer mode
        onResume, // Always show Resume when stopped (resumeFresh handles live return)
        onLeave,
        onOpenBookmarkPicker,
      }}
      framePicker={{
        frameCount,
        selectedCount: selectedFrameCount,
        onOpen: onOpenFramePicker,
      }}
    >
      {/* Right arrow icon */}
      <ChevronRight className={`${iconSm} text-slate-400 shrink-0`} />

      {/* Catalog Selection */}
      {hasCatalog ? (
        <button
          onClick={onOpenCatalogPicker}
          className={buttonBase}
          title="Select Decoder Catalog"
        >
          {isDefaultCatalog && (
            <Star className={`${iconSm} text-amber-500 flex-shrink-0`} fill="currentColor" />
          )}
          <span className="max-w-32 truncate">{catalogName}</span>
        </button>
      ) : (
        <button
          onClick={onOpenCatalogPicker}
          className={buttonBase}
          title="Select Decoder Catalog"
        >
          <span className="text-[color:var(--text-muted)] italic">No catalog</span>
        </button>
      )}

      {/* Raw bytes toggle */}
      {onToggleRawBytes && (
        <button
          onClick={onToggleRawBytes}
          className={toggleButtonClass(showRawBytes, "purple")}
          title={showRawBytes ? "Hide raw bytes" : "Show raw bytes"}
        >
          <Glasses className={iconSm} />
        </button>
      )}

      {/* Clear decoded values */}
      {onClear && (
        <button
          onClick={onClear}
          className={buttonBase}
          title="Clear decoded values"
        >
          <Trash2 className={iconSm} />
        </button>
      )}

      {/* View mode toggle (single vs per-source) */}
      {onToggleViewMode && (
        <button
          onClick={onToggleViewMode}
          className={toggleButtonClass(viewMode === 'per-source', 'blue')}
          title={viewMode === 'single' ? 'Show per source address' : 'Show single (most recent)'}
        >
          {viewMode === 'per-source' ? (
            <Users className={iconSm} />
          ) : (
            <User className={iconSm} />
          )}
        </button>
      )}

      {/* Frame filters button - colored when any filter is active */}
      {onOpenFilterDialog && (
        <button
          onClick={onOpenFilterDialog}
          className={toggleButtonClass(hasFilters, 'yellow')}
          title={hasFilters ? `Filters: ${filterParts.join(', ')}` : 'Set frame filters'}
        >
          <Filter className={iconSm} />
        </button>
      )}

      {/* Hide unseen frames toggle */}
      {onToggleHideUnseen && (
        <button
          onClick={onToggleHideUnseen}
          className={toggleButtonClass(hideUnseen, 'blue')}
          title={hideUnseen ? 'Showing only seen frames' : 'Showing all frames'}
        >
          {hideUnseen ? (
            <EyeOff className={iconSm} />
          ) : (
            <Eye className={iconSm} />
          )}
        </button>
      )}

      {/* ASCII toggle */}
      {onToggleAsciiGutter && (
        <button
          onClick={onToggleAsciiGutter}
          className={`${iconButtonBase} ${
            showAsciiGutter
              ? "!bg-yellow-600 !text-white hover:!bg-yellow-500"
              : ""
          }`}
          title={showAsciiGutter ? "Hide ASCII column" : "Show ASCII column"}
        >
          <Type className={iconMd} />
        </button>
      )}
    </AppTopBar>
  );
}
