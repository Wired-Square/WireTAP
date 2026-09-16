// ui/src/apps/discovery/hooks/handlers/useDiscoveryBookmarkHandlers.ts
//
// Bookmark handlers for Discovery: save bookmark, bookmark dialog.
// Bookmark loading is now in shared useTimeHandlers.

import { useCallback } from "react";
import { addFavorite } from "../../../../utils/favorites";
import { microsToDatetimeLocal } from "../../../../utils/timeFormat";

export interface UseDiscoveryBookmarkHandlersParams {
  // State
  ioProfile: string | null;
  sourceProfileId: string | null;

  // State setters
  setBookmarkFrameId: (id: number) => void;
  setBookmarkFrameTime: (time: string) => void;

  // Dialog controls
  openBookmarkDialog: () => void;
}

export function useDiscoveryBookmarkHandlers({
  ioProfile,
  sourceProfileId,
  setBookmarkFrameId,
  setBookmarkFrameTime,
  openBookmarkDialog,
}: UseDiscoveryBookmarkHandlersParams) {
  // Handle bookmark button click from DiscoveryFramesView
  const handleBookmark = useCallback((frameId: number, timestampUs: number) => {
    setBookmarkFrameId(frameId);
    setBookmarkFrameTime(microsToDatetimeLocal(timestampUs));
    openBookmarkDialog();
  }, [setBookmarkFrameId, setBookmarkFrameTime, openBookmarkDialog]);

  // Handle saving a bookmark
  // Use sourceProfileId (the original data source) rather than ioProfile (which may be a buffer ID)
  const handleSaveBookmark = useCallback(async (name: string, fromTime: string, toTime: string) => {
    const profileId = sourceProfileId || ioProfile;
    if (!profileId) return;
    await addFavorite(name, profileId, fromTime, toTime);
  }, [sourceProfileId, ioProfile]);

  return {
    handleBookmark,
    handleSaveBookmark,
  };
}

export type DiscoveryBookmarkHandlers = ReturnType<typeof useDiscoveryBookmarkHandlers>;
