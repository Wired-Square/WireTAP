// ui/src/apps/discovery/views/serial/TabBar.tsx
//
// Tab bar with controls for the serial discovery view.
// Uses the shared DiscoveryTabBar with serial-specific controls.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Layers, Filter, Settings, Network, FileText } from 'lucide-react';
import { iconSm, iconXs } from '../../../../styles/spacing';
import { DiscoveryTabBar, type TabDefinition } from '../../components';
import type { FramingConfig } from '../../../../stores/discoveryStore';
import { TOOL_TAB_CONFIG } from '../../../../stores/discoveryToolboxStore';
import { useDiscoveryUIStore } from '../../../../stores/discoveryUIStore';
import { Button, IconButton } from '../../../../components/Button';

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
  /** Whether the session emits raw bytes (from capabilities.data_streams) */
  emitsRawBytes: boolean;
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
  emitsRawBytes,
  onTabClose,
}: TabBarProps) {
  const { t } = useTranslation("discovery");
  // Column visibility toggles from UI store (shared with CAN view)
  const showBusColumn = useDiscoveryUIStore((s) => s.showBusColumn);
  const toggleShowBusColumn = useDiscoveryUIStore((s) => s.toggleShowBusColumn);
  const showAsciiColumn = useDiscoveryUIStore((s) => s.showAsciiColumn);
  const toggleShowAsciiColumn = useDiscoveryUIStore((s) => s.toggleShowAsciiColumn);
  const getFramingLabel = () => {
    if (!framingConfig) return t("serial.framingLabel");
    switch (framingConfig.mode) {
      case 'slip': return t("serial.framingSlip");
      case 'raw': return t("serial.framingDelimiter");
      case 'modbus_rtu': return t("serial.framingModbus");
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
      result.push({ id: 'raw', label: t("serial.tabRawBytes"), count: byteCount, countColor: 'gray' as const });
    }

    result.push({ id: 'framed', label: t("serial.tabFramedBytes"), count: frameCount, countColor: 'green' as const });

    // Show Filtered tab when there are filtered frames (frames excluded by minFrameLength filter)
    if (filteredCount > 0) {
      result.push({ id: 'filtered', label: t("serial.tabFiltered"), count: filteredCount, countColor: 'orange' as const });
    }

    // Dynamic tool output tabs
    if (hasSerialFramingResults) {
      result.push({ id: TOOL_TAB_CONFIG['serial-framing'].tabId, label: TOOL_TAB_CONFIG['serial-framing'].label, closeable: true });
    }
    if (hasSerialPayloadResults) {
      result.push({ id: TOOL_TAB_CONFIG['serial-payload'].tabId, label: TOOL_TAB_CONFIG['serial-payload'].label, closeable: true });
    }

    return result;
  }, [byteCount, frameCount, filteredCount, hasSerialFramingResults, hasSerialPayloadResults, framingAccepted, emitsRawBytes, t]);

  // Serial-specific control buttons (compact styling)
  // Only show controls on raw and framed tabs, not on tool output tabs
  const serialControls = (activeTab === 'raw' || activeTab === 'framed') ? (
    <>
      {/* Column visibility toggles */}
      <IconButton
        onClick={toggleShowBusColumn}
        variant="surface"
        tone="cyan"
        size="sm"
        pressed={showBusColumn}
        title={showBusColumn ? t("serial.hideBus") : t("serial.showBus")}
      >
        <Network className={iconSm} />
      </IconButton>
      <IconButton
        onClick={toggleShowAsciiColumn}
        variant="surface"
        tone="warning"
        size="sm"
        pressed={showAsciiColumn}
        title={showAsciiColumn ? t("serial.hideAscii") : t("serial.showAscii")}
      >
        <FileText className={iconSm} />
      </IconButton>

      {/* View settings - only on raw bytes tab */}
      {activeTab === 'raw' && (
        <Button
          onClick={onOpenRawBytesViewDialog}
          size="sm"
          title={t("serial.configureRawBytes")}
        >
          <Settings className={iconXs} />
          {t("serial.viewLabel")}
        </Button>
      )}

      {/* Framing button - only shown when raw bytes are available for client-side framing */}
      {emitsRawBytes && (
        <Button
          onClick={onOpenFramingDialog}
          tone="primary"
          size="sm"
          pressed={!!framingConfig}
          title={t("serial.configureFraming")}
        >
          <Layers className={iconXs} />
          {getFramingLabel()}
        </Button>
      )}

      {/* Filter button - only on framed tab (filtering applies to frames, not bytes) */}
      {activeTab === 'framed' && (
        <Button
          onClick={onOpenFilterDialog}
          tone="warning"
          size="sm"
          pressed={minFrameLength > 0}
          title={t("serial.configureFilters")}
        >
          <Filter className={iconXs} />
          {minFrameLength > 0 ? t("serial.minLengthFilter", { min: minFrameLength }) : t("serial.filterAll")}
        </Button>
      )}
    </>
  ) : null;

  return (
    <DiscoveryTabBar
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={(id) => onTabChange(id)}
      protocolLabel={t("serial.protocolLabel")}
      isStreaming={isStreaming}
      isRecorded={isRecorded}
      controls={serialControls}
      onTabClose={onTabClose}
    />
  );
}
