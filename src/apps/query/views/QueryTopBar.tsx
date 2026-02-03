// src/apps/query/views/QueryTopBar.tsx
//
// Top bar for the Query app. Shows amber icon and session controls like other apps.
// Uses same IOSessionControls pattern as Discovery/Decoder. Includes catalog picker.

import { useMemo } from "react";
import { DatabaseZap, Star } from "lucide-react";
import type { IOProfile } from "../../../types/common";
import type { CatalogMetadata } from "../../../api/catalog";
import AppTopBar from "../../../components/AppTopBar";
import { buttonBase } from "../../../styles/buttonStyles";
import { iconSm } from "../../../styles/spacing";

interface Props {
  // IO profile selection (filtered to postgres only)
  ioProfiles: IOProfile[];
  ioProfile: string | null;
  defaultReadProfileId?: string | null;

  // Catalog selection
  catalogs: CatalogMetadata[];
  catalogPath: string | null;
  defaultCatalogFilename?: string | null;
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
  defaultCatalogFilename,
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
  // Normalise path for cross-platform comparison (Windows backslashes)
  const normalisePath = (p: string) => p.replace(/\\/g, "/");
  const normalisedCatalogPath = catalogPath ? normalisePath(catalogPath) : null;
  const selectedCatalog = useMemo(
    () => catalogs.find((c) => normalisePath(c.path) === normalisedCatalogPath),
    [catalogs, normalisedCatalogPath]
  );

  const hasCatalog = !!selectedCatalog;
  const catalogName = selectedCatalog?.name ?? "";
  const isDefaultCatalog = selectedCatalog?.filename === defaultCatalogFilename;

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
    >
      {/* Catalog Selection */}
      {hasCatalog ? (
        <button
          onClick={onOpenCatalogPicker}
          className={buttonBase}
          title="Select Decoder Catalog"
        >
          {isDefaultCatalog && (
            <Star className={`${iconSm} text-amber-500 flex-shrink-0`} fill="currentColor" />
          )}
          <span className="max-w-32 truncate">{catalogName}</span>
        </button>
      ) : (
        <button
          onClick={onOpenCatalogPicker}
          className={buttonBase}
          title="Select Decoder Catalog"
        >
          <span className="text-[color:var(--text-muted)] italic">No catalog</span>
        </button>
      )}
    </AppTopBar>
  );
}
