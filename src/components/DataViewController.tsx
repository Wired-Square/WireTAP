// ui/src/components/DataViewController.tsx
//
// Unified view controller component for data views (Discovery, Decoder, etc.).
// Combines the tab bar, pagination toolbar, and timeline scrubber into a single component.

import DataViewTabBar, { type TabDefinition, type ProtocolBadge } from "./DataViewTabBar";
import DataViewPaginationToolbar, { type PageSizeOption, FRAME_PAGE_SIZE_OPTIONS } from "./DataViewPaginationToolbar";
import DataViewTimelineSection from "./DataViewTimelineSection";

interface DataViewControllerProps {
  // Tab bar props
  tabs: TabDefinition[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  protocolLabel: string;
  /** Optional badges to show next to the protocol label (e.g., framing mode, filter) */
  protocolBadges?: ProtocolBadge[];
  /** Called when the protocol badge is clicked (for future functionality) */
  onProtocolClick?: () => void;
  isStreaming?: boolean;
  /** Current timestamp in epoch seconds */
  timestamp?: number | null;
  /** @deprecated Use timestamp instead */
  displayTime?: string | null;
  isRecorded?: boolean;
  /** Current frame index (0-based) for display */
  frameIndex?: number | null;
  /** Total frame count for display */
  totalFrames?: number | null;
  /** Custom controls to show in the tab bar (e.g., ASCII toggle button) */
  tabBarControls?: React.ReactNode;
  /** Called when a closeable tab's close button is clicked */
  onTabClose?: (tabId: string) => void;

  // Toolbar props
  showToolbar?: boolean;
  currentPage: number;
  totalPages: number;
  pageSize: number;
  pageSizeOptions?: PageSizeOption[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  toolbarLoading?: boolean;
  toolbarDisabled?: boolean;
  /** Content to show on the left side of the toolbar (e.g., time range inputs) */
  toolbarLeftContent?: React.ReactNode;
  /** Content to show in the center of the toolbar (before loading indicator) */
  toolbarCenterContent?: React.ReactNode;
  /** Informational content for the center zone (e.g., frame counter) */
  toolbarInfoContent?: React.ReactNode;
  /** Content for the right zone, before the page size selector (e.g., speed selector) */
  toolbarRightContent?: React.ReactNode;
  /** Hide pagination buttons but still show page size selector */
  hidePagination?: boolean;
  /** Hide page size selector (use when pagination is not applicable at all) */
  hidePageSize?: boolean;

  // Timeline props
  showTimeline: boolean;
  minTimeUs: number;
  maxTimeUs: number;
  currentTimeUs: number;
  onTimelineScrub: (timeUs: number) => void;
  displayTimeFormat: "delta-last" | "delta-start" | "timestamp" | "human";
  streamStartTimeUs?: number | null;
  timelineDisabled?: boolean;
  /** Total frames in buffer (enables frame-based timeline mode) */
  timelineTotalFrames?: number;
  /** Current frame index (0-based, for frame-based timeline) */
  timelineCurrentFrameIndex?: number;
  /** Called when user scrubs to a new frame index */
  timelineOnFrameChange?: (frameIndex: number) => void;
}

/**
 * Unified view controller component for data views.
 * Combines the tab bar, pagination toolbar, and timeline scrubber into a single component.
 *
 * Structure:
 * - DataViewTabBar (protocol badge, tabs, time display, controls)
 * - DataViewPaginationToolbar (optional - page size, pagination buttons)
 * - DataViewTimelineSection (optional - timeline scrubber)
 */
export default function DataViewController({
  // Tab bar
  tabs,
  activeTab,
  onTabChange,
  protocolLabel,
  protocolBadges,
  onProtocolClick,
  isStreaming = false,
  timestamp,
  displayTime,
  isRecorded = false,
  frameIndex,
  totalFrames,
  tabBarControls,
  onTabClose,

  // Toolbar
  showToolbar = true,
  currentPage,
  totalPages,
  pageSize,
  pageSizeOptions = FRAME_PAGE_SIZE_OPTIONS,
  onPageChange,
  onPageSizeChange,
  toolbarLoading = false,
  toolbarDisabled = false,
  toolbarLeftContent,
  toolbarCenterContent,
  toolbarInfoContent,
  toolbarRightContent,
  hidePagination = false,
  hidePageSize = false,

  // Timeline
  showTimeline,
  minTimeUs,
  maxTimeUs,
  currentTimeUs,
  onTimelineScrub,
  displayTimeFormat,
  streamStartTimeUs,
  timelineDisabled = false,
  timelineTotalFrames,
  timelineCurrentFrameIndex,
  timelineOnFrameChange,
}: DataViewControllerProps) {
  return (
    <>
      {/* Tab Bar */}
      <DataViewTabBar
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={onTabChange}
        protocolLabel={protocolLabel}
        protocolBadges={protocolBadges}
        onProtocolClick={onProtocolClick}
        isStreaming={isStreaming}
        timestamp={timestamp}
        displayTime={displayTime}
        isRecorded={isRecorded}
        frameIndex={frameIndex}
        totalFrames={totalFrames}
        controls={tabBarControls}
        onTabClose={onTabClose}
      />

      {/* Pagination Toolbar */}
      {showToolbar && (
        <DataViewPaginationToolbar
          currentPage={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          pageSizeOptions={pageSizeOptions}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
          isLoading={toolbarLoading}
          disabled={toolbarDisabled}
          leftContent={toolbarLeftContent}
          centerContent={toolbarCenterContent}
          infoContent={toolbarInfoContent}
          rightContent={toolbarRightContent}
          hidePagination={hidePagination}
          hidePageSize={hidePageSize}
        />
      )}

      {/* Timeline Scrubber */}
      <DataViewTimelineSection
        show={showTimeline}
        minTimeUs={minTimeUs}
        maxTimeUs={maxTimeUs}
        currentTimeUs={currentTimeUs}
        onPositionChange={onTimelineScrub}
        totalFrames={timelineTotalFrames}
        currentFrameIndex={timelineCurrentFrameIndex}
        onFrameChange={timelineOnFrameChange}
        displayTimeFormat={displayTimeFormat}
        streamStartTimeUs={streamStartTimeUs}
        disabled={timelineDisabled}
      />
    </>
  );
}

// Re-export types for convenience
export type { TabDefinition, ProtocolBadge } from "./DataViewTabBar";
export type { PageSizeOption } from "./DataViewPaginationToolbar";
export { FRAME_PAGE_SIZE_OPTIONS, BYTE_PAGE_SIZE_OPTIONS } from "./DataViewPaginationToolbar";
