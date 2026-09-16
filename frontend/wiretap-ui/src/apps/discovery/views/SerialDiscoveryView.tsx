// ui/src/apps/discovery/views/SerialDiscoveryView.tsx
//
// Tabbed view for serial discovery:
// - Raw Bytes tab: scrolling hex dump of raw bytes with timestamps
// - Framed Bytes tab: frames after framing is applied
// - Toolbar with framing controls

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useDiscoveryStore, useDiscoverySerialStore, TOOL_TAB_CONFIG } from '../../../stores/discoveryStore';
import {
  ByteView,
  FramedDataView,
  TabBar,
  FramingModeDialog,
  FilterDialog,
  RawBytesViewDialog,
} from './serial';
import SerialAnalysisResultView from './tools/SerialAnalysisResultView';
import { borderDataView, textWarning } from '../../../styles/colourTokens';
import { emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from '../../../styles/typography';

interface SerialDiscoveryViewProps {
  isStreaming?: boolean;
  displayTimeFormat?: 'delta-last' | 'delta-start' | 'timestamp' | 'human';
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
  /** The session's byte capture and its total, as Rust pushes them (ByteCounts 0x19). */
  bytesCaptureId: string | null;
  byteCount: number;
}

export default function SerialDiscoveryView({ isStreaming = false, displayTimeFormat = 'human', isRecorded = false, emitsRawBytes, sessionFramesCaptureId, sessionFramesCount, bytesCaptureId, byteCount }: SerialDiscoveryViewProps) {
  const [showFramingDialog, setShowFramingDialog] = useState(false);
  const [showFilterDialog, setShowFilterDialog] = useState(false);
  const [showRawBytesViewDialog, setShowRawBytesViewDialog] = useState(false);

  // Use serial store directly for data that needs reliable reactivity
  // The composed useDiscoveryStore can lose reactivity when other stores trigger re-renders
  const framingConfig = useDiscoverySerialStore((s) => s.framingConfig);
  const framedData = useDiscoverySerialStore((s) => s.framedData);
  const framingAccepted = useDiscoverySerialStore((s) => s.framingAccepted);
  const rawBytesViewConfig = useDiscoverySerialStore((s) => s.rawBytesViewConfig);
  const activeTab = useDiscoverySerialStore((s) => s.activeTab);
  const setActiveTab = useDiscoverySerialStore((s) => s.setActiveTab);

  // Get main frames store for real-time streaming with backend framing
  // During streaming, frames from backend framing go to the main frames store
  const mainFrames = useDiscoveryStore((s) => s.frames);
  const mainFrameVersion = useDiscoveryStore((s) => s.frameVersion);
  const setFramingConfig = useDiscoverySerialStore((s) => s.setFramingConfig);
  const applyFrameIdMapping = useDiscoverySerialStore((s) => s.applyFrameIdMapping);
  const clearFrameIdMapping = useDiscoverySerialStore((s) => s.clearFrameIdMapping);
  const applySourceMapping = useDiscoverySerialStore((s) => s.applySourceMapping);
  const clearSourceMapping = useDiscoverySerialStore((s) => s.clearSourceMapping);
  const setRawBytesViewConfig = useDiscoverySerialStore((s) => s.setRawBytesViewConfig);
  const framedCaptureId = useDiscoverySerialStore((s) => s.framedCaptureId);
  const backendFrameCount = useDiscoverySerialStore((s) => s.backendFrameCount);
  const minFrameLength = useDiscoverySerialStore((s) => s.minFrameLength);
  const setMinFrameLength = useDiscoverySerialStore((s) => s.setMinFrameLength);
  const frameIdExtractionConfig = useDiscoverySerialStore((s) => s.frameIdExtractionConfig);
  const sourceExtractionConfig = useDiscoverySerialStore((s) => s.sourceExtractionConfig);
  const filteredFrameCount = useDiscoverySerialStore((s) => s.filteredFrameCount);

  // Use composed store for actions that need coordination between stores
  const applyFraming = useDiscoveryStore((s) => s.applyFraming);
  const acceptFraming = useDiscoveryStore((s) => s.acceptFraming);
  const setSerialConfig = useDiscoveryStore((s) => s.setSerialConfig);
  const serialFramingResults = useDiscoveryStore((s) => s.toolbox.serialFramingResults);
  const serialPayloadResults = useDiscoveryStore((s) => s.toolbox.serialPayloadResults);

  // Count frames (excluding incomplete ones for unique ID count)
  const completeFrames = framedData.filter(f => !f.incomplete);

  // For streaming sessions, filter mainFrames by minFrameLength
  // This applies the filter to real-time backend-framed sessions
  const { filteredStreamingFrames, excludedStreamingFrames } = useMemo(() => {
    // Only filter mainFrames during streaming when using backend framing (no local framedData)
    if (!isStreaming || framedData.length > 0) {
      return { filteredStreamingFrames: mainFrames, excludedStreamingFrames: [] };
    }
    if (minFrameLength <= 0) {
      return { filteredStreamingFrames: mainFrames, excludedStreamingFrames: [] };
    }
    const filtered = mainFrames.filter(f => f.dlc >= minFrameLength);
    const excluded = mainFrames.filter(f => f.dlc < minFrameLength);
    return { filteredStreamingFrames: filtered, excludedStreamingFrames: excluded };
  }, [isStreaming, framedData.length, mainFrameVersion, minFrameLength]);

  // Effective filtered count: use backend filteredFrameCount for client-side framing,
  // or computed excludedStreamingFrames.length for streaming
  const effectiveFilteredCount = isStreaming && framedData.length === 0
    ? excludedStreamingFrames.length
    : filteredFrameCount;

  // Track previous values to detect meaningful changes
  const prevFramingConfigRef = useRef<typeof framingConfig>(null);
  const prevByteCountRef = useRef<number>(0);
  const prevMinFrameLengthRef = useRef<number>(0);
  const prevFrameIdConfigRef = useRef<typeof frameIdExtractionConfig>(null);
  const prevSourceConfigRef = useRef<typeof sourceExtractionConfig>(null);

  // Track pending framing operation to serialize calls and avoid race conditions
  // When a framing operation is in progress, we queue the next one to run after it completes
  const pendingFramingRef = useRef<Promise<unknown> | null>(null);
  const queuedFramingRef = useRef<boolean>(false);

  // Re-frame when the user changes anything about the framing, and once more when the
  // stream stops and the byte total settles.
  //
  // Deliberately NOT on every byte-count change while streaming: apply_framing_to_capture
  // reads the *whole* byte capture and re-frames all of it, so running that at the 2 Hz
  // byte cadence costs time proportional to the session so far — quadratic over a run.
  // Framing incrementally would let this follow the stream; until then, a user-initiated
  // change still re-frames immediately, which is what makes changing framing mid-session
  // visible.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const configChanged = JSON.stringify(framingConfig) !== JSON.stringify(prevFramingConfigRef.current);
    const bytesChanged = !isStreaming && byteCount !== prevByteCountRef.current;
    const filterChanged = minFrameLength !== prevMinFrameLengthRef.current;
    const frameIdConfigChanged = JSON.stringify(frameIdExtractionConfig) !== JSON.stringify(prevFrameIdConfigRef.current);
    const sourceConfigChanged = JSON.stringify(sourceExtractionConfig) !== JSON.stringify(prevSourceConfigRef.current);

    prevFramingConfigRef.current = framingConfig;
    if (bytesChanged) prevByteCountRef.current = byteCount;
    prevMinFrameLengthRef.current = minFrameLength;
    prevFrameIdConfigRef.current = frameIdExtractionConfig;
    prevSourceConfigRef.current = sourceExtractionConfig;

    // Apply framing if we have a config and any relevant setting changed or new bytes arrived
    if (framingConfig && byteCount > 0 && (configChanged || bytesChanged || filterChanged || frameIdConfigChanged || sourceConfigChanged)) {
      // Serialize framing calls to avoid race conditions
      // If a framing operation is already in progress, queue this one
      if (pendingFramingRef.current) {
        queuedFramingRef.current = true;
        return;
      }

      const runFraming = async () => {
        pendingFramingRef.current = applyFraming();
        await pendingFramingRef.current;
        pendingFramingRef.current = null;

        // If another framing was queued while we were running, run it now
        if (queuedFramingRef.current) {
          queuedFramingRef.current = false;
          runFraming();
        }
      };

      runFraming();
    }
  }, [framingConfig, byteCount, isStreaming, minFrameLength, frameIdExtractionConfig, sourceExtractionConfig]); // Intentionally omit applyFraming - it's unstable

  // Track if we've already auto-switched to framed tab
  const hasAutoSwitchedRef = useRef(false);

  // Auto-switch to framed tab when frames are first generated (only once)
  // Check multiple sources:
  // - framedData.length > 0: client-side framing produced frames
  // - framedCaptureId !== null: client-side framing created a backend buffer
  // - backendFrameCount > 0: real-time backend framing is producing frames
  useEffect(() => {
    const hasFrames = framedData.length > 0 || framedCaptureId !== null || backendFrameCount > 0;
    if (hasFrames && !hasAutoSwitchedRef.current) {
      hasAutoSwitchedRef.current = true;
      setActiveTab('framed');
    }
    // Reset when frames are cleared
    if (!hasFrames) {
      hasAutoSwitchedRef.current = false;
    }
  }, [framedData.length, framedCaptureId, backendFrameCount, setActiveTab]);

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
    <div className={`flex flex-col flex-1 min-h-0 overflow-hidden rounded-lg border ${borderDataView}`}>
      {/* Tab Bar with Controls */}
      <TabBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        frameCount={
          isStreaming && framedData.length === 0
            ? filteredStreamingFrames.length
            : (framedCaptureId ? backendFrameCount : (backendFrameCount > 0 ? backendFrameCount : completeFrames.length))
        }
        byteCount={byteCount}
        filteredCount={effectiveFilteredCount}
        framingConfig={framingConfig}
        minFrameLength={minFrameLength}
        hasSerialFramingResults={serialFramingResults !== null}
        hasSerialPayloadResults={serialPayloadResults !== null}
        isStreaming={isStreaming}
        isRecorded={isRecorded}
        onOpenRawBytesViewDialog={() => setShowRawBytesViewDialog(true)}
        onOpenFramingDialog={() => setShowFramingDialog(true)}
        onOpenFilterDialog={() => setShowFilterDialog(true)}
        framingAccepted={framingAccepted}
        emitsRawBytes={emitsRawBytes}
        onTabClose={handleTabClose}
      />

      {/* Tab Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'raw' && (
          <ByteView viewConfig={rawBytesViewConfig} displayTimeFormat={displayTimeFormat} isStreaming={isStreaming} bytesCaptureId={bytesCaptureId} byteCount={byteCount} />
        )}
        {activeTab === 'framed' && (
          <FramedDataView
            frames={isStreaming && framedData.length === 0 ? filteredStreamingFrames : framedData}
            onAccept={handleAcceptFraming}
            onApplyIdMapping={applyFrameIdMapping}
            onClearIdMapping={clearFrameIdMapping}
            onApplySourceMapping={applySourceMapping}
            onClearSourceMapping={clearSourceMapping}
            sessionFramesCaptureId={sessionFramesCaptureId}
            sessionFramesCount={sessionFramesCount}
            accepted={framingAccepted}
            framingMode={framingConfig?.mode}
            displayTimeFormat={displayTimeFormat}
            isStreaming={isStreaming}
          />
        )}
        {activeTab === 'filtered' && (
          <div className={emptyStateContainer}>
            {effectiveFilteredCount > 0 ? (
              <div className={emptyStateText}>
                <p className={`${emptyStateHeading} ${textWarning}`}>{effectiveFilteredCount} frames filtered out</p>
                <p className={emptyStateDescription}>Frames shorter than {minFrameLength} bytes</p>
              </div>
            ) : (
              <p className={emptyStateText}>No filtered frames. Adjust the minimum frame length filter to see excluded frames.</p>
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
