// ui/src/apps/discovery/components/index.ts
//
// Components for Discovery views (CAN and Serial).
// Re-exports shared components from ui/src/components/ for backwards compatibility.

// Re-export shared components with Discovery aliases for backwards compatibility
export { default as DiscoveryTabBar, type TabDefinition, type DataViewTabBarProps as DiscoveryTabBarProps, type StreamingStatus } from '../../../components/DataViewTabBar';
export { default as PaginationToolbar, type PageSizeOption, FRAME_PAGE_SIZE_OPTIONS, BYTE_PAGE_SIZE_OPTIONS } from '../../../components/DataViewPaginationToolbar';
export { default as TimelineSection } from '../../../components/DataViewTimelineSection';
export { default as DiscoveryViewController } from '../../../components/DataViewController';

// Discovery-specific components
export { default as FrameDataTable, type FrameRow, type FrameDataTableProps } from './FrameDataTable';
export { default as DiscoveryFindBar } from './DiscoveryFindBar';
