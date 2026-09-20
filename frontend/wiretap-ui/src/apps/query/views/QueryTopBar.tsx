// src/apps/query/views/QueryTopBar.tsx
//
// Top bar for the Query app. Shows amber icon and session controls like other apps.
// Uses AppTopBar's catalog section for consistent catalog display.

import type { IOProfile } from "../../../types/common";
import type { CatalogMetadata } from "../../../api/catalog";
import AppTopBar from "../../../components/AppTopBar";

interface Props {
  // IO profile selection (WireTAP backend profiles only)
  ioProfiles: IOProfile[];
  ioProfile: string | null;
  defaultReadProfileId?: string | null;

  // Catalog selection
  catalogs: CatalogMetadata[];
  catalogPath: string | null;
  onOpenCatalogPicker: () => void;

  // Frame counts (for tooltip)
  uniqueFrameCount?: number;
  totalFrameCount?: number;

  // Dialog trigger
  onOpenIoSessionPicker: () => void;

  // Session state (from useIOSessionManager)
  isStreaming: boolean;
  isPaused?: boolean;
  isStopped?: boolean;

  // Session actions
  onPlay?: () => void;
  onPause?: () => void;
  onLeave?: () => void;
  onStop?: () => void;
  onDestroy?: () => void;
}

export default function QueryTopBar({
  ioProfiles,
  ioProfile,
  defaultReadProfileId,
  catalogs,
  catalogPath,
  onOpenCatalogPicker,
  uniqueFrameCount,
  totalFrameCount,
  onOpenIoSessionPicker,
  isStreaming,
  isPaused,
  isStopped,
  onPlay,
  onPause,
  onLeave,
  onStop,
  onDestroy,
}: Props) {
  return (
    <AppTopBar
      app="query"
      frameIdFormat
      ioSession={{
        ioProfile,
        ioProfiles,
        defaultReadProfileId,
        frameCount: uniqueFrameCount,
        totalFrameCount,
        onOpenIoSessionPicker,
        isStreaming,
        isPaused,
        isStopped,
        onPlay,
        onPause,
        onLeave,
        onStop,
        onDestroy,
      }}
      catalog={{
        catalogs,
        catalogPath,
        onOpen: onOpenCatalogPicker,
      }}
    />
  );
}
