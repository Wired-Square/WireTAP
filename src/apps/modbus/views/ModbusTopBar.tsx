// ui/src/apps/modbus/views/ModbusTopBar.tsx

import { Server, Wifi, Cable } from "lucide-react";
import { flexRowGap2 } from "../../../styles/spacing";
import type { IOProfile } from "../../../types/common";
import AppTopBar from "../../../components/AppTopBar";
import type { CatalogMetadata } from "../../../api/catalog";
import type { ModbusTransportMode } from "../stores/modbusStore";

interface Props {
  ioProfiles: IOProfile[];
  ioProfile: string | null;
  defaultReadProfileId?: string | null;
  sessionId?: string | null;
  multiBusProfiles?: string[];
  isStreaming: boolean;
  isPaused?: boolean;
  isStopped?: boolean;
  ioState?: string | null;
  onOpenIoPicker: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  onLeave?: () => void;

  // Transport mode
  transportMode: ModbusTransportMode;

  // Catalog
  catalogs: CatalogMetadata[];
  catalogPath: string | null;
  onOpenCatalogPicker: () => void;

  // Clear
  onClearCapture?: () => void;
  hasData?: boolean;

  // Poll info
  pollGroupCount: number;
  registerCount: number;

  // Frame picker
  frameCount: number;
  selectedFrameCount: number;
  onOpenFramePicker: () => void;
}

export default function ModbusTopBar({
  ioProfiles,
  ioProfile,
  defaultReadProfileId,
  sessionId,
  multiBusProfiles = [],
  isStreaming,
  isPaused = false,
  isStopped = false,
  ioState,
  onOpenIoPicker,
  onPlay,
  onPause,
  onLeave,
  onClearCapture,
  hasData = false,
  transportMode,
  catalogs,
  catalogPath,
  onOpenCatalogPicker,
  pollGroupCount,
  registerCount,
  frameCount,
  selectedFrameCount,
  onOpenFramePicker,
}: Props) {
  return (
    <AppTopBar
      icon={Server}
      iconColour="text-amber-400"
      ioSession={{
        ioProfile,
        ioProfiles,
        defaultReadProfileId,
        sessionId,
        multiBusProfiles,
        ioState,
        onOpenIoSessionPicker: onOpenIoPicker,
        isStreaming,
        isPaused,
        isStopped,
        onPlay,
        onPause,
        onLeave,
        onClearCapture,
        hasData,
      }}
      framePicker={{
        frameCount,
        selectedCount: selectedFrameCount,
        onOpen: onOpenFramePicker,
        disabled: frameCount === 0,
        disabledTitle: "No registers loaded",
      }}
      catalog={{
        catalogs,
        catalogPath,
        onOpen: onOpenCatalogPicker,
      }}
    >
      <div className={flexRowGap2}>
        {/* Transport mode badge */}
        <span className={`text-xs px-2 py-0.5 rounded flex items-center gap-1 ${
          transportMode === 'tcp'
            ? 'bg-blue-600/20 text-[color:var(--text-blue)]'
            : 'bg-orange-600/20 text-[color:var(--text-orange)]'
        }`}>
          {transportMode === 'tcp' ? <Wifi size={10} /> : <Cable size={10} />}
          {transportMode === 'tcp' ? 'TCP' : 'RTU'}
        </span>

        {/* Poll group count */}
        {pollGroupCount > 0 && (
          <span className="text-xs px-2 py-0.5 rounded bg-[var(--bg-surface)] text-[color:var(--text-secondary)]">
            {pollGroupCount} poll{pollGroupCount !== 1 ? 's' : ''} · {registerCount} reg{registerCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>
    </AppTopBar>
  );
}
