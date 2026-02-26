// ui/src/apps/discovery/views/serial/TabBar.tsx
//
// Tab bar with controls for the serial discovery view.
// Uses the shared DiscoveryTabBar with serial-specific controls.

import { useMemo } from 'react';
import { Layers, Filter, Settings, Network, FileText } from 'lucide-react';
import { iconSm, iconXs } from '../../../../styles/spacing';
import { bgSurface, textSecondary } from '../../../../styles';
import { DiscoveryTabBar, type TabDefinition } from '../../components';
import type { FramingConfig } from '../../../../stores/discoveryStore';
import { TOOL_TAB_CONFIG } from '../../../../stores/discoveryToolboxStore';
import { useDiscoveryUIStore } from '../../../../stores/discoveryUIStore';

export type TabId = string;

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  frameCount: number;
  byteCount: number;
  /** Count of frames excluded by minFrameLength filter */
  filteredCount: number;
  framingConfig: FramingConfig | null;
  /** Independent minimum frame length filter (0 = no filter) */
  minFrameLength: number;
  /** Whether serial framing analysis results exist */
  hasSerialFramingResults: boolean;
  /** Whether serial payload analysis results exist */
  hasSerialPayloadResults: boolean;
  isStreaming?: boolean;
  isRecorded?: boolean;
  onOpenRawBytesViewDialog: () => void;
  onOpenFramingDialog: () => void;
  onOpenFilterDialog: () => void;
  /** Whether framing has been accepted - hides Raw Bytes tab when true */
  framingAccepted?: boolean;
  /** Whether the session emits raw bytes (from capabilities) - defaults to true for standalone serial */
  emitsRawBytes?: boolean;
  /** Called when a closeable tab's close button is clicked */
  onTabClose?: (tabId: string) => void;
}

export default function TabBar({
  activeTab,
  onTabChange,
  frameCount,
  byteCount,
  filteredCount,
  framingConfig,
  minFrameLength,
  hasSerialFramingResults,
  hasSerialPayloadResults,
  isStreaming = false,
  isRecorded = false,
  onOpenRawBytesViewDialog,
  onOpenFramingDialog,
  onOpenFilterDialog,
  framingAccepted = false,
  emitsRawBytes = true, // Default true for standalone serial sessions
  onTabClose,
}: TabBarProps) {
  // Column visibility toggles from UI store (shared with CAN view)
  const showBusColumn = useDiscoveryUIStore((s) => s.showBusColumn);
  const toggleShowBusColumn = useDiscoveryUIStore((s) => s.toggleShowBusColumn);
  const showAsciiColumn = useDiscoveryUIStore((s) => s.showAsciiColumn);
  const toggleShowAsciiColumn = useDiscoveryUIStore((s) => s.toggleShowAsciiColumn);
  const getFramingLabel = () => {
    if (!framingConfig) return 'Framing';
    switch (framingConfig.mode) {
      case 'slip': return 'SLIP';
      case 'raw': return 'Delimiter';
      case 'modbus_rtu': return 'Modbus';
    }
  };

  // Build tab definitions
  // Raw Bytes tab is shown if:
  // 1. The session emits raw bytes (emitsRawBytes from capabilities), AND
  // 2. Framing hasn't been accepted yet (user hasn't applied client-side framing)
  const tabs: TabDefinition[] = useMemo(() => {
    const result: TabDefinition[] = [];

    // Only show Raw Bytes tab if session emits bytes and framing hasn't been accepted
    if (emitsRawBytes && !framingAccepted) {
      result.push({ id: 'raw', label: 'Raw Bytes', count: byteCount, countColor: 'gray' as const });
    }

    result.push({ id: 'framed', label: 'Framed Bytes', count: frameCount, countColor: 'green' as const });

    // Show Filtered tab when there are filtered frames (frames excluded by minFrameLength filter)
    if (filteredCount > 0) {
      result.push({ id: 'filtered', label: 'Filtered', count: filteredCount, countColor: 'orange' as const });
    }

    // Dynamic tool output tabs
    if (hasSerialFramingResults) {
      result.push({ id: TOOL_TAB_CONFIG['serial-framing'].tabId, label: TOOL_TAB_CONFIG['serial-framing'].label, closeable: true });
    }
    if (hasSerialPayloadResults) {
      result.push({ id: TOOL_TAB_CONFIG['serial-payload'].tabId, label: TOOL_TAB_CONFIG['serial-payload'].label, closeable: true });
    }

    return result;
  }, [byteCount, frameCount, filteredCount, hasSerialFramingResults, hasSerialPayloadResults, framingAccepted, emitsRawBytes]);

  // Serial-specific control buttons (compact styling)
  // Only show controls on raw and framed tabs, not on tool output tabs
  const serialControls = (activeTab === 'raw' || activeTab === 'framed') ? (
    <>
      {/* Column visibility toggles */}
      <button
        onClick={toggleShowBusColumn}
        className={`p-1.5 rounded transition-colors ${
          showBusColumn
            ? 'bg-cyan-600 text-white hover:bg-cyan-500'
            : `${bgSurface} ${textSecondary} hover:brightness-95`
        }`}
        title={showBusColumn ? 'Hide Bus column' : 'Show Bus column'}
      >
        <Network className={iconSm} />
      </button>
      <button
        onClick={toggleShowAsciiColumn}
        className={`p-1.5 rounded transition-colors ${
          showAsciiColumn
            ? 'bg-yellow-600 text-white hover:bg-yellow-500'
            : `${bgSurface} ${textSecondary} hover:brightness-95`
        }`}
        title={showAsciiColumn ? 'Hide ASCII column' : 'Show ASCII column'}
      >
        <FileText className={iconSm} />
      </button>

      {/* View settings - only on raw bytes tab */}
      {activeTab === 'raw' && (
        <button
          onClick={onOpenRawBytesViewDialog}
          className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded transition-colors ${bgSurface} ${textSecondary} hover:brightness-95`}
          title="Configure raw bytes display"
        >
          <Settings className={iconXs} />
          View
        </button>
      )}

      {/* Framing button - only shown when raw bytes are available for client-side framing */}
      {emitsRawBytes && (
        <button
          onClick={onOpenFramingDialog}
          className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded transition-colors ${
            framingConfig
              ? 'bg-blue-600 text-white hover:bg-blue-500'
              : `${bgSurface} ${textSecondary} hover:brightness-95`
          }`}
          title="Configure framing mode"
        >
          <Layers className={iconXs} />
          {getFramingLabel()}
        </button>
      )}

      {/* Filter button - only on framed tab (filtering applies to frames, not bytes) */}
      {activeTab === 'framed' && (
        <button
          onClick={onOpenFilterDialog}
          className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded transition-colors ${
            minFrameLength > 0
              ? 'bg-amber-600 text-white hover:bg-amber-500'
              : `${bgSurface} ${textSecondary} hover:brightness-95`
          }`}
          title="Configure frame filters"
        >
          <Filter className={iconXs} />
          {minFrameLength > 0 ? `${minFrameLength}+` : 'All'}
        </button>
      )}
    </>
  ) : null;

  return (
    <DiscoveryTabBar
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={(id) => onTabChange(id)}
      protocolLabel="Serial"
      isStreaming={isStreaming}
      isRecorded={isRecorded}
      controls={serialControls}
      onTabClose={onTabClose}
    />
  );
}
