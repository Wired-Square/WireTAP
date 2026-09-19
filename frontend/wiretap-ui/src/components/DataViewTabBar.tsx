// ui/src/components/DataViewTabBar.tsx
//
// Shared tab bar component for data views (Discovery, Decoder, etc.).
// Provides consistent dark-themed tabbed interface with status display and controls.

import { ReactNode, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import TimeDisplay from './TimeDisplay';
import ProtocolBadge, { type StreamingStatus } from './ProtocolBadge';
import ContextMenu from './ContextMenu';
import {
  bgDataToolbar,
  borderDataView,
  hoverBg,
} from '../styles';
import { iconXs } from '../styles/spacing';
import { textDataPrimary } from '../styles/colourTokens';
import { Badge, type BadgeTone } from './Badge';
import { Tab, TabCount, TabDot, Tabs, type TabCountTone } from './Tabs';

// Re-export StreamingStatus for backwards compatibility
export type { StreamingStatus } from './ProtocolBadge';

export interface TabDefinition {
  id: string;
  label: string;
  count?: number;
  countTone?: TabCountTone;
  /** Optional prefix to show before count (e.g., ">" for truncated buffers) */
  countPrefix?: string;
  /** Show purple dot indicator when true and tab is not active */
  hasIndicator?: boolean;
  /** When true, tab shows an inline close button and a right-click Close tab menu */
  closeable?: boolean;
}

/** Badge to display next to the protocol label */
export interface ProtocolBadge {
  label: string;
  tone?: BadgeTone;
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
  /** Streaming status: 'stopped' (red), 'live' (green), or 'paused' (orange) */
  status?: StreamingStatus;
  /** @deprecated Use status instead. Whether data is currently streaming */
  isStreaming?: boolean;
  /** Current timestamp in epoch seconds (optional) */
  timestamp?: number | null;
  /** @deprecated Use timestamp instead. Pre-formatted time string */
  displayTime?: string | null;
  /** Whether the data source is recorded (e.g., WireTAP backend, CSV) vs live */
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
  const { t } = useTranslation("common");

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
        />
      </div>

      {/* Protocol configuration badges (framing, filter, etc.) */}
      {protocolBadges?.map((badge, idx) => (
        <Badge key={idx} tone={badge.tone} className="ml-1">
          {badge.label}
        </Badge>
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
        <Badge mono className="ml-2">
          <span>Frame</span>
          <span className={textDataPrimary}>{(frameIndex + 1).toLocaleString()}</span>
          {totalFrames != null && (
            <>
              <span>/</span>
              <span className={textDataPrimary}>{totalFrames.toLocaleString()}</span>
            </>
          )}
        </Badge>
      )}

      <Tabs inline>
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const canClose = tab.closeable === true && onTabClose !== undefined;

        return (
          <Tab
            key={tab.id}
            selected={isActive}
            onClick={() => onTabChange(tab.id)}
            onContextMenu={canClose ? (e) => handleTabContextMenu(e, tab.id) : undefined}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <TabCount tone={tab.countTone}>
                ({tab.countPrefix ?? ''}{tab.count.toLocaleString()})
              </TabCount>
            )}
            {tab.hasIndicator && !isActive && <TabDot />}
            {/*
              A span rather than a nested <button>: the tab itself is a button, and
              interactive content cannot nest. role/tabIndex/onKeyDown give it the
              keyboard behaviour the element would otherwise have supplied.
            */}
            {canClose && (
              <span
                role="button"
                tabIndex={0}
                aria-label={t("tabs.close")}
                title={t("tabs.close")}
                onClick={(e) => { e.stopPropagation(); onTabClose?.(tab.id); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onTabClose?.(tab.id);
                  }
                }}
                className={`-mr-1 p-0.5 rounded inline-flex items-center align-middle ${hoverBg}`}
              >
                <X className={iconXs} />
              </span>
            )}
          </Tab>
        );
      })}
      </Tabs>

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
            label: t("tabs.close"),
            icon: <X />,
            onClick: () => onTabClose?.(contextMenu.tabId),
          }]}
          position={contextMenu.position}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
