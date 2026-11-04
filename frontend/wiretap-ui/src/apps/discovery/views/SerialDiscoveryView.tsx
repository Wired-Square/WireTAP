// ui/src/apps/discovery/views/SerialDiscoveryView.tsx
//
// Tabbed view for serial discovery:
// - Raw Bytes tab: scrolling hex dump of raw bytes with timestamps
// - Framed Bytes tab: frames after framing is applied
// - Toolbar with framing controls

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useDiscoveryStore, useDiscoverySerialStore, TOOL_TAB_CONFIG } from '../../../stores/discoveryStore';
import { backendFramingConfig, framedSource } from '../../../stores/discoverySerialStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { setCaptureFraming } from '../../../api/capture';
import { tlog } from '../../../api/settings';
import {
  ByteView,
  FramedDataView,
  TabBar,
  FramingModeDialog,
  FilterDialog,
  RawBytesViewDialog,
} from './serial';
import SerialAnalysisResultView from './tools/SerialAnalysisResultView';
import { borderDefault, textWarning } from '../../../styles/colourTokens';
import { emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from '../../../styles/typography';

interface SerialDiscoveryViewProps {
  isStreaming?: boolean;
  displayTimeFormat?: 'delta-last' | 'delta-start' | 'timestamp' | 'human';
  useLocalTimezone: boolean;
  isRecorded?: boolean;
  /** Whether the session emits raw bytes (from capabilities.data_streams) */
  emitsRawBytes: boolean;
  /**
   * The session's own frames capture, for a reader that frames on the wire
   * (SLIP, Modbus RTU) rather than the user framing stored bytes afterwards.
   */
  sessionFramesCaptureId: string | null;
  /** Frame count for `sessionFramesCaptureId`. */
  sessionFramesCount: number;
  sessionId: string | null;
  /** The session's byte capture and its total, as Rust pushes them (ByteCounts 0x19). */
  bytesCaptureId: string | null;
  byteCount: number;
}

export default function SerialDiscoveryView({ isStreaming = false, displayTimeFormat = 'human', useLocalTimezone, isRecorded = false, emitsRawBytes, sessionFramesCaptureId, sessionFramesCount, sessionId, bytesCaptureId, byteCount }: SerialDiscoveryViewProps) {
  const { t } = useTranslation("discovery");
  const [showFramingDialog, setShowFramingDialog] = useState(false);
  const [showFilterDialog, setShowFilterDialog] = useState(false);
  const [showRawBytesViewDialog, setShowRawBytesViewDialog] = useState(false);

  // Use serial store directly for data that needs reliable reactivity
  // The composed useDiscoveryStore can lose reactivity when other stores trigger re-renders
  const framingConfig = useDiscoverySerialStore((s) => s.framingConfig);
  const framingAccepted = useDiscoverySerialStore((s) => s.framingAccepted);
  const rawBytesViewConfig = useDiscoverySerialStore((s) => s.rawBytesViewConfig);
  const activeTab = useDiscoverySerialStore((s) => s.activeTab);
  const setActiveTab = useDiscoverySerialStore((s) => s.setActiveTab);
  const setFramingConfig = useDiscoverySerialStore((s) => s.setFramingConfig);
  const applyFrameIdMapping = useDiscoverySerialStore((s) => s.applyFrameIdMapping);
  const clearFrameIdMapping = useDiscoverySerialStore((s) => s.clearFrameIdMapping);
  const applySourceMapping = useDiscoverySerialStore((s) => s.applySourceMapping);
  const clearSourceMapping = useDiscoverySerialStore((s) => s.clearSourceMapping);
  const setRawBytesViewConfig = useDiscoverySerialStore((s) => s.setRawBytesViewConfig);
  const minFrameLength = useDiscoverySerialStore((s) => s.minFrameLength);
  const setMinFrameLength = useDiscoverySerialStore((s) => s.setMinFrameLength);
  const frameIdExtractionConfig = useDiscoverySerialStore((s) => s.frameIdExtractionConfig);
  const sourceExtractionConfig = useDiscoverySerialStore((s) => s.sourceExtractionConfig);
  const framing = useSessionStore((s) => (sessionId ? s.sessions[sessionId]?.framing : undefined) ?? null);

  // Use composed store for actions that need coordination between stores
  const acceptFraming = useDiscoveryStore((s) => s.acceptFraming);
  const setSerialConfig = useDiscoveryStore((s) => s.setSerialConfig);
  const serialFramingResults = useDiscoveryStore((s) => s.toolbox.serialFramingResults);
  const serialPayloadResults = useDiscoveryStore((s) => s.toolbox.serialPayloadResults);

  const source = framedSource(framing, { captureId: sessionFramesCaptureId, frameCount: sessionFramesCount });
  // A reader's minimum length is its own setting, applied before the capture.
  const filteredCount = source.readerFramed ? 0 : framing?.filtered_count ?? 0;

  // Rust frames the stored bytes and follows the stream; this only says how. A view
  // that never set framing sends nothing, so it cannot switch off another window's.
  const hadFramingRef = useRef(false);
  useEffect(() => {
    if (!sessionId || (!framingConfig && !hadFramingRef.current)) return;
    hadFramingRef.current = framingConfig !== null;
    const config = framingConfig && backendFramingConfig(framingConfig, minFrameLength, frameIdExtractionConfig, sourceExtractionConfig);
    setCaptureFraming(sessionId, config).then(
      (state) => {
        if (config && state) tlog.info(`[SerialDiscoveryView] Framed ${config.mode}: ${state.frame_count} frames, ${state.filtered_count} filtered`);
      },
      (error) => tlog.info(`[SerialDiscoveryView] Failed to apply framing in backend: ${error}`),
    );
  }, [sessionId, framingConfig, minFrameLength, frameIdExtractionConfig, sourceExtractionConfig]);

  const hasFrames = source.frameCount > 0;
  useEffect(() => {
    if (hasFrames) setActiveTab('framed');
  }, [hasFrames, setActiveTab]);

  // Switch to framed tab when framing is accepted (Raw Bytes tab will be hidden)
  useEffect(() => {
    if (framingAccepted && activeTab === 'raw') {
      setActiveTab('framed');
    }
  }, [framingAccepted, activeTab, setActiveTab]);

  // Handle filter change - set independent minFrameLength (0 = no filter)
  const handleFilterChange = (newMinLength: number) => {
    setMinFrameLength(newMinLength);
  };

  // Handle accept framing - save serial config and accept framing
  const handleAcceptFraming = (serialConfig?: import('../../../utils/frameExport').SerialFrameConfig) => {
    if (serialConfig) {
      setSerialConfig(serialConfig);
    }
    acceptFraming();
  };

  // Handle closing a tool output tab
  const clearToolResult = useDiscoveryStore((s) => s.clearToolResult);
  const handleTabClose = useCallback((tabId: string) => {
    clearToolResult(tabId);
    if (activeTab === tabId) {
      setActiveTab('framed');
    }
  }, [clearToolResult, activeTab, setActiveTab]);

  // Safety: fall back to 'framed' if active tab is a tool tab that no longer exists
  useEffect(() => {
    if (activeTab.startsWith('tool:')) {
      const hasTab =
        (activeTab === TOOL_TAB_CONFIG['serial-framing'].tabId && serialFramingResults !== null) ||
        (activeTab === TOOL_TAB_CONFIG['serial-payload'].tabId && serialPayloadResults !== null);
      if (!hasTab) {
        setActiveTab('framed');
      }
    }
  }, [activeTab, serialFramingResults, serialPayloadResults, setActiveTab]);

  return (
    <div className={`flex flex-col flex-1 min-h-0 overflow-hidden rounded-lg border ${borderDefault}`}>
      {/* Tab Bar with Controls */}
      <TabBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        frameCount={source.frameCount}
        byteCount={byteCount}
        filteredCount={filteredCount}
        framingConfig={framingConfig}
        minFrameLength={minFrameLength}
        hasSerialFramingResults={serialFramingResults !== null}
        hasSerialPayloadResults={serialPayloadResults !== null}
        isStreaming={isStreaming}
        isRecorded={isRecorded}
        onOpenRawBytesViewDialog={() => setShowRawBytesViewDialog(true)}
        onOpenFramingDialog={() => setShowFramingDialog(true)}
        onOpenFilterDialog={source.readerFramed ? undefined : () => setShowFilterDialog(true)}
        framingAccepted={framingAccepted}
        emitsRawBytes={emitsRawBytes}
        onTabClose={handleTabClose}
      />

      {/* Tab Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'raw' && (
          <ByteView viewConfig={rawBytesViewConfig} displayTimeFormat={displayTimeFormat} useLocalTimezone={useLocalTimezone} isStreaming={isStreaming} bytesCaptureId={bytesCaptureId} byteCount={byteCount} />
        )}
        {activeTab === 'framed' && (
          <FramedDataView
            captureId={source.captureId}
            sessionId={sessionId}
            onAccept={handleAcceptFraming}
            onApplyIdMapping={applyFrameIdMapping}
            onClearIdMapping={clearFrameIdMapping}
            onApplySourceMapping={applySourceMapping}
            onClearSourceMapping={clearSourceMapping}
            accepted={framingAccepted}
            framingMode={framingConfig?.mode}
            displayTimeFormat={displayTimeFormat}
            useLocalTimezone={useLocalTimezone}
            isStreaming={isStreaming}
            isRecorded={isRecorded}
          />
        )}
        {activeTab === 'filtered' && (
          <div className={emptyStateContainer}>
            {filteredCount > 0 ? (
              <div className={emptyStateText}>
                <p className={`${emptyStateHeading} ${textWarning}`}>{t("serial.filteredOut", { count: filteredCount })}</p>
                <p className={emptyStateDescription}>{t("serial.shorterThan", { min: minFrameLength })}</p>
              </div>
            ) : (
              <p className={emptyStateText}>{t("serial.noFiltered")}</p>
            )}
          </div>
        )}
        {activeTab === TOOL_TAB_CONFIG['serial-framing'].tabId && serialFramingResults && (
          <SerialAnalysisResultView mode="framing" onClose={() => handleTabClose(TOOL_TAB_CONFIG['serial-framing'].tabId)} />
        )}
        {activeTab === TOOL_TAB_CONFIG['serial-payload'].tabId && serialPayloadResults && (
          <SerialAnalysisResultView mode="payload" onClose={() => handleTabClose(TOOL_TAB_CONFIG['serial-payload'].tabId)} />
        )}
      </div>

      {/* Dialogs */}
      <FramingModeDialog
        isOpen={showFramingDialog}
        onClose={() => setShowFramingDialog(false)}
        config={framingConfig}
        onApply={setFramingConfig}
      />
      <FilterDialog
        isOpen={showFilterDialog}
        onClose={() => setShowFilterDialog(false)}
        minLength={minFrameLength}
        onApply={handleFilterChange}
      />
      <RawBytesViewDialog
        isOpen={showRawBytesViewDialog}
        onClose={() => setShowRawBytesViewDialog(false)}
        config={rawBytesViewConfig}
        onApply={setRawBytesViewConfig}
      />
    </div>
  );
}
