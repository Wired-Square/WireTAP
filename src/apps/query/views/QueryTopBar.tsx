// src/apps/query/views/QueryTopBar.tsx
//
// Top bar for the Query app. Shows amber icon and session controls like other apps.
// Uses AppTopBar's catalog section for consistent catalog display.

import { DatabaseZap } from "lucide-react";
import type { IOProfile } from "../../../types/common";
import type { CatalogMetadata } from "../../../api/catalog";
import AppTopBar from "../../../components/AppTopBar";

interface Props {
  // IO profile selection (filtered to postgres only)
  ioProfiles: IOProfile[];
  ioProfile: string | null;
  defaultReadProfileId?: string | null;

  // Catalog selection
  catalogs: CatalogMetadata[];
  catalogPath: string | null;
  onOpenCatalogPicker: () => void;

  // Dialog trigger
  onOpenIoReaderPicker: () => void;

  // Session state (from useIOSessionManager)
  isStreaming: boolean;
  isStopped?: boolean;
  supportsTimeRange?: boolean;

  // Session actions
  onStop?: () => void;
  onResume?: () => void;
  onLeave?: () => void;
  onOpenBookmarkPicker?: () => void;
}

export default function QueryTopBar({
  ioProfiles,
  ioProfile,
  defaultReadProfileId,
  catalogs,
  catalogPath,
  onOpenCatalogPicker,
  onOpenIoReaderPicker,
  isStreaming,
  isStopped,
  supportsTimeRange,
  onStop,
  onResume,
  onLeave,
  onOpenBookmarkPicker,
}: Props) {
  return (
    <AppTopBar
      icon={DatabaseZap}
      iconColour="text-[color:var(--text-amber)]"
      ioSession={{
        ioProfile,
        ioProfiles,
        defaultReadProfileId,
        onOpenIoReaderPicker,
        isStreaming,
        isStopped,
        supportsTimeRange,
        onStop,
        onResume,
        onLeave,
        onOpenBookmarkPicker,
      }}
      catalog={{
        catalogs,
        catalogPath,
        onOpen: onOpenCatalogPicker,
      }}
    />
  );
}
