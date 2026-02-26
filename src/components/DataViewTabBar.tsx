// ui/src/components/DataViewTabBar.tsx
//
// Shared tab bar component for data views (Discovery, Decoder, etc.).
// Provides consistent dark-themed tabbed interface with status display and controls.

import { ReactNode, useState, useCallback } from 'react';
import { X } from 'lucide-react';
import TimeDisplay from './TimeDisplay';
import ProtocolBadge, { type StreamingStatus } from './ProtocolBadge';
import ContextMenu from './ContextMenu';
import {
  bgDataToolbar,
  borderDataView,
} from '../styles';
import { iconXs } from '../styles/spacing';
import {
  dataViewTabClass,
  badgeColorClass,
  tabCountColorClass,
} from '../styles/buttonStyles';

// Re-export StreamingStatus for backwards compatibility
export type { StreamingStatus } from './ProtocolBadge';

export interface TabDefinition {
  id: string;
  label: string;
  count?: number;
  countColor?: 'green' | 'gray' | 'purple' | 'orange';
  /** Optional prefix to show before count (e.g., ">" for truncated buffers) */
  countPrefix?: string;
  /** Show purple dot indicator when true and tab is not active */
  hasIndicator?: boolean;
  /** When true, tab can be closed via right-click context menu */
  closeable?: boolean;
}

/** Badge to display next to the protocol label */
export interface ProtocolBadge {
  label: string;
  color?: 'green' | 'blue' | 'purple' | 'gray' | 'amber' | 'cyan';
}

export interface DataViewTabBarProps {
  /** Tab definitions */
  tabs: TabDefinition[];
  /** Currently active tab ID */
  activeTab: string;
  /** Called when a tab is clicked */
  onTabChange: (tabId: string) => void;

  /** Protocol or mode label shown on the left */
  protocolLabel: string;
  /** Optional badges to show next to the protocol label (e.g., framing mode, filter) */
  protocolBadges?: ProtocolBadge[];
  /** Called when the protocol badge is clicked (for future functionality) */
  onProtocolClick?: () => void;
  /** Streaming status: 'stopped' (red), 'live' (green), or 'paused' (orange) */
  status?: StreamingStatus;
  /** @deprecated Use status instead. Whether data is currently streaming */
  isStreaming?: boolean;
  /** Current timestamp in epoch seconds (optional) */
  timestamp?: number | null;
  /** @deprecated Use timestamp instead. Pre-formatted time string */
  displayTime?: string | null;
  /** Whether the data source is recorded (e.g., PostgreSQL, CSV) vs live */
  isRecorded?: boolean;
  /** Current frame index (0-based) for display */
  frameIndex?: number | null;
  /** Total frame count for display */
  totalFrames?: number | null;

  /** Additional control buttons rendered on the right */
  controls?: ReactNode;
  /** Called when a closeable tab is closed (via context menu or programmatically) */
  onTabClose?: (tabId: string) => void;
}

// ============================================================================
// Component
// ============================================================================

export default function DataViewTabBar({
  tabs,
  activeTab,
  onTabChange,
  protocolLabel,
  protocolBadges,
  onProtocolClick,
  status,
  isStreaming,
  timestamp,
  displayTime,
  isRecorded = false,
  frameIndex,
  totalFrames,
  controls,
  onTabClose,
}: DataViewTabBarProps) {
  // Context menu state for closeable tabs
  const [contextMenu, setContextMenu] = useState<{ tabId: string; position: { x: number; y: number } } | null>(null);

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    setContextMenu({ tabId, position: { x: e.clientX, y: e.clientY } });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  return (
    <div className={`flex-shrink-0 flex items-center border-b ${borderDataView} ${bgDataToolbar}`}>
      {/* Protocol badge with status light */}
      <div className="ml-1">
        <ProtocolBadge
          label={protocolLabel}
          status={status}
          isStreaming={isStreaming}
          isRecorded={isRecorded}
          onClick={onProtocolClick}
        />
      </div>

      {/* Protocol configuration badges (framing, filter, etc.) */}
      {protocolBadges && protocolBadges.length > 0 && protocolBadges.map((badge, idx) => (
        <div
          key={idx}
          className={`flex items-center gap-1 ml-1 px-2 py-0.5 rounded text-xs ${badgeColorClass(badge.color ?? 'gray')}`}
        >
          {badge.label}
        </div>
      ))}

      {/* Time display with timezone support */}
      {(timestamp != null || displayTime != null) && (
        <div className="flex items-center gap-1 ml-2">
          <TimeDisplay
            timestamp={timestamp ?? displayTime ?? null}
            showDate={isRecorded}
            showTime={true}
            compact={true}
            allowOverride={true}
          />
        </div>
      )}

      {/* Frame index display (for debugging/playback position) */}
      {frameIndex != null && (
        <div className="flex items-center gap-1 ml-2 px-1.5 py-0.5 bg-gray-700/50 rounded text-xs font-mono text-gray-400">
          <span>Frame</span>
          <span className="text-gray-200">{(frameIndex + 1).toLocaleString()}</span>
          {totalFrames != null && (
            <>
              <span>/</span>
              <span className="text-gray-300">{totalFrames.toLocaleString()}</span>
            </>
          )}
        </div>
      )}

      {/* Tabs */}
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;

        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            onContextMenu={tab.closeable ? (e) => handleTabContextMenu(e, tab.id) : undefined}
            className={dataViewTabClass(isActive, tab.hasIndicator)}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className={`ml-1.5 text-xs ${tabCountColorClass(tab.countColor ?? 'gray')}`}>
                ({tab.countPrefix ?? ''}{tab.count.toLocaleString()})
              </span>
            )}
            {tab.hasIndicator && !isActive && (
              <span className="ml-1 w-1.5 h-1.5 bg-purple-500 rounded-full inline-block" />
            )}
          </button>
        );
      })}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Control Buttons */}
      {controls && (
        <div className="flex items-center gap-1.5 px-2">
          {controls}
        </div>
      )}

      {/* Context menu for closeable tabs */}
      {contextMenu && (
        <ContextMenu
          items={[{
            label: 'Close tab',
            icon: <X className={iconXs} />,
            onClick: () => onTabClose?.(contextMenu.tabId),
          }]}
          position={contextMenu.position}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
