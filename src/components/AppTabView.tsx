// ui/src/components/AppTabView.tsx
//
// Shared tab view container for data apps (Discovery, Decoder, etc.).
// Provides the dark-themed rounded container with tab bar, optional toolbar,
// optional timeline, and scrollable content area.

import { type ReactNode } from "react";
import DataViewController, {
  type TabDefinition,
  type ProtocolBadge,
  type PageSizeOption,
  FRAME_PAGE_SIZE_OPTIONS,
} from "./DataViewController";
import { bgDarkView, borderDarkView } from "../styles";

/**
 * Toolbar configuration for AppTabView.
 */
interface ToolbarConfig {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  pageSizeOptions?: PageSizeOption[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  loading?: boolean;
  disabled?: boolean;
  leftContent?: ReactNode;
  centerContent?: ReactNode;
  hidePagination?: boolean;
}

/**
 * Timeline configuration for AppTabView.
 */
interface TimelineConfig {
  minTimeUs: number;
  maxTimeUs: number;
  currentTimeUs: number;
  onScrub: (timeUs: number) => void;
  displayTimeFormat: "delta-last" | "delta-start" | "timestamp" | "human";
  streamStartTimeUs?: number | null;
  disabled?: boolean;
}

/**
 * Content area configuration for AppTabView.
 */
interface ContentAreaConfig {
  /** Additional classes for the content container (replaces default "p-4") */
  className?: string;
  /** Whether to include space-y-4 for vertical spacing between children */
  spaceY?: boolean;
  /**
   * Whether to wrap children in the scrollable content container.
   * Set to false for children that handle their own scrolling (e.g., virtualised tables).
   * Defaults to true.
   */
  wrap?: boolean;
}

/**
 * Props for AppTabView - the shared tab view container for data apps.
 */
interface AppTabViewProps {
  // === Tab Bar (required) ===
  tabs: TabDefinition[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  protocolLabel: string;

  // === Tab Bar (optional) ===
  protocolBadges?: ProtocolBadge[];
  onProtocolClick?: () => void;
  isStreaming?: boolean;
  timestamp?: number | null;
  /** @deprecated Use timestamp instead */
  displayTime?: string | null;
  isRecorded?: boolean;
  /** Custom controls for the tab bar (e.g., column toggle buttons) */
  tabBarControls?: ReactNode;

  // === Toolbar (optional - omit to hide) ===
  toolbar?: ToolbarConfig;

  // === Timeline (optional - omit to hide) ===
  timeline?: TimelineConfig;

  // === Content Area ===
  /** Content area configuration */
  contentArea?: ContentAreaConfig;

  /**
   * Children to render in the content area.
   * Rendered unconditionally - parent is responsible for conditional rendering
   * based on activeTab.
   */
  children: ReactNode;
}

/**
 * Shared tab view container for data apps (Discovery, Decoder, etc.).
 *
 * Provides:
 * - Dark-themed rounded container with border
 * - DataViewController integration (tab bar, toolbar, timeline)
 * - Scrollable content area with consistent styling
 *
 * @example
 * ```tsx
 * <AppTabView
 *   tabs={tabs}
 *   activeTab={activeTab}
 *   onTabChange={setActiveTab}
 *   protocolLabel="CAN"
 *   toolbar={{ currentPage, totalPages, pageSize, onPageChange, onPageSizeChange }}
 *   timeline={{ minTimeUs, maxTimeUs, currentTimeUs, onScrub, displayTimeFormat: "human" }}
 * >
 *   {activeTab === 'frames' && <FrameTable />}
 *   {activeTab === 'analysis' && <AnalysisView />}
 * </AppTabView>
 * ```
 */
export default function AppTabView({
  // Tab bar (required)
  tabs,
  activeTab,
  onTabChange,
  protocolLabel,
  // Tab bar (optional)
  protocolBadges,
  onProtocolClick,
  isStreaming = false,
  timestamp,
  displayTime,
  isRecorded = false,
  tabBarControls,
  // Toolbar (optional)
  toolbar,
  // Timeline (optional)
  timeline,
  // Content area
  contentArea,
  children,
}: AppTabViewProps) {
  // Whether to wrap children in the scrollable content container
  const wrapContent = contentArea?.wrap !== false;

  // Build content area classes
  const contentClasses = [
    "flex-1 min-h-0 overflow-auto overscroll-none rounded-b-lg",
    bgDarkView,
    contentArea?.className ?? "p-4",
    contentArea?.spaceY ? "space-y-4" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={`flex flex-col flex-1 min-h-0 overflow-hidden rounded-lg border ${borderDarkView}`}
    >
      {/* View Controller: Tab Bar + Toolbar + Timeline */}
      <DataViewController
        // Tab bar
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
        tabBarControls={tabBarControls}
        // Toolbar
        showToolbar={toolbar !== undefined}
        currentPage={toolbar?.currentPage ?? 0}
        totalPages={toolbar?.totalPages ?? 1}
        pageSize={toolbar?.pageSize ?? -1}
        pageSizeOptions={toolbar?.pageSizeOptions ?? FRAME_PAGE_SIZE_OPTIONS}
        onPageChange={toolbar?.onPageChange ?? (() => {})}
        onPageSizeChange={toolbar?.onPageSizeChange ?? (() => {})}
        toolbarLoading={toolbar?.loading}
        toolbarDisabled={toolbar?.disabled}
        toolbarLeftContent={toolbar?.leftContent}
        toolbarCenterContent={toolbar?.centerContent}
        hidePagination={toolbar?.hidePagination}
        // Timeline
        showTimeline={timeline !== undefined}
        minTimeUs={timeline?.minTimeUs ?? 0}
        maxTimeUs={timeline?.maxTimeUs ?? 0}
        currentTimeUs={timeline?.currentTimeUs ?? 0}
        onTimelineScrub={timeline?.onScrub ?? (() => {})}
        displayTimeFormat={timeline?.displayTimeFormat ?? "human"}
        streamStartTimeUs={timeline?.streamStartTimeUs}
        timelineDisabled={timeline?.disabled}
      />

      {/* Content Area */}
      {wrapContent ? (
        <div className={contentClasses}>{children}</div>
      ) : (
        children
      )}
    </div>
  );
}

// Re-export types for convenience
export type { TabDefinition, ProtocolBadge, PageSizeOption } from "./DataViewController";
export { FRAME_PAGE_SIZE_OPTIONS, BYTE_PAGE_SIZE_OPTIONS } from "./DataViewController";
export type { ToolbarConfig, TimelineConfig, ContentAreaConfig };
