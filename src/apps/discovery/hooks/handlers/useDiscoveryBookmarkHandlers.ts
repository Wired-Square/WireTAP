// ui/src/apps/discovery/hooks/handlers/useDiscoveryBookmarkHandlers.ts
//
// Bookmark handlers for Discovery: load, save, bookmark dialog.

import { useCallback } from "react";
import { addFavorite, markFavoriteUsed, type TimeRangeFavorite } from "../../../../utils/favorites";
import { localToUtc, microsToDatetimeLocal } from "../../../../utils/timeFormat";

export interface UseDiscoveryBookmarkHandlersParams {
  // State
  ioProfile: string | null;
  sourceProfileId: string | null;
  bufferModeEnabled: boolean;

  // State setters
  setBookmarkFrameId: (id: number) => void;
  setBookmarkFrameTime: (time: string) => void;
  setActiveBookmarkId: (id: string | null) => void;

  // Store actions
  setStartTime: (time: string) => void;
  setEndTime: (time: string) => void;
  setIoProfile: (profileId: string | null) => void;
  disableBufferMode: () => void;

  // Session actions
  setTimeRange: (start: string, end: string) => Promise<void>;
  reinitialize: (profileId?: string, options?: { startTime?: string; endTime?: string }) => Promise<void>;

  // Dialog controls
  openBookmarkDialog: () => void;

  // Constants
  BUFFER_PROFILE_ID: string;
}

export function useDiscoveryBookmarkHandlers({
  ioProfile,
  sourceProfileId,
  bufferModeEnabled,
  setBookmarkFrameId,
  setBookmarkFrameTime,
  setActiveBookmarkId,
  setStartTime,
  setEndTime,
  setIoProfile,
  disableBufferMode,
  setTimeRange,
  reinitialize,
  openBookmarkDialog,
  BUFFER_PROFILE_ID,
}: UseDiscoveryBookmarkHandlersParams) {
  // Handle bookmark button click from DiscoveryFramesView
  const handleBookmark = useCallback((frameId: number, timestampUs: number) => {
    setBookmarkFrameId(frameId);
    setBookmarkFrameTime(microsToDatetimeLocal(timestampUs));
    openBookmarkDialog();
  }, [setBookmarkFrameId, setBookmarkFrameTime, openBookmarkDialog]);

  // Handle saving a bookmark
  // Use sourceProfileId (the original data source) rather than ioProfile (which may be BUFFER_PROFILE_ID)
  const handleSaveBookmark = useCallback(async (name: string, fromTime: string, toTime: string) => {
    const profileId = sourceProfileId || ioProfile;
    if (!profileId) return;
    await addFavorite(name, profileId, fromTime, toTime);
  }, [sourceProfileId, ioProfile]);

  // Handle loading a bookmark (sets time range and marks bookmark as active)
  const handleLoadBookmark = useCallback(async (bookmark: TimeRangeFavorite) => {
    console.log("[Discovery:handleLoadBookmark] Loading bookmark:", bookmark.name);
    console.log("[Discovery:handleLoadBookmark] Bookmark times - start:", bookmark.startTime, "end:", bookmark.endTime);
    console.log("[Discovery:handleLoadBookmark] Current state - ioProfile:", ioProfile, "sourceProfileId:", sourceProfileId, "bufferModeEnabled:", bufferModeEnabled);

    setStartTime(bookmark.startTime);
    setEndTime(bookmark.endTime);
    setActiveBookmarkId(bookmark.id);

    const startUtc = localToUtc(bookmark.startTime);
    const endUtc = localToUtc(bookmark.endTime);
    console.log("[Discovery:handleLoadBookmark] UTC times - start:", startUtc, "end:", endUtc);

    // Only need a valid start time to load a bookmark (end time can be empty/undefined)
    if (startUtc) {
      // Determine the profile to use for the bookmark query
      const targetProfile = sourceProfileId || ioProfile;

      // If viewing buffer data, reinitialize to get fresh data from the source
      if (bufferModeEnabled && targetProfile) {
        console.log("[Discovery:handleLoadBookmark] Buffer mode enabled, reinitializing with profile:", targetProfile);
        disableBufferMode();
        if (ioProfile === BUFFER_PROFILE_ID) {
          setIoProfile(targetProfile);
        }
        await reinitialize(targetProfile, { startTime: startUtc, endTime: endUtc });
        console.log("[Discovery:handleLoadBookmark] Reinitialized with new time range");
      } else if (targetProfile) {
        // Not viewing buffer - just update the time range on current session
        console.log("[Discovery:handleLoadBookmark] Calling setTimeRange on current session...");
        await setTimeRange(startUtc, endUtc ?? "");
        console.log("[Discovery:handleLoadBookmark] setTimeRange completed");
      } else {
        console.warn("[Discovery:handleLoadBookmark] No target profile available");
      }
    } else {
      console.warn("[Discovery:handleLoadBookmark] Skipping setTimeRange - no valid start time");
    }

    await markFavoriteUsed(bookmark.id);
    console.log("[Discovery:handleLoadBookmark] Done");
  }, [
    ioProfile,
    sourceProfileId,
    bufferModeEnabled,
    BUFFER_PROFILE_ID,
    setStartTime,
    setEndTime,
    setActiveBookmarkId,
    setIoProfile,
    disableBufferMode,
    setTimeRange,
    reinitialize,
  ]);

  return {
    handleBookmark,
    handleSaveBookmark,
    handleLoadBookmark,
  };
}

export type DiscoveryBookmarkHandlers = ReturnType<typeof useDiscoveryBookmarkHandlers>;
