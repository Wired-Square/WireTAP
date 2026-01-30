// ui/src/apps/settings/hooks/handlers/useBookmarkHandlers.ts

import {
  addFavorite,
  updateFavorite,
  deleteFavorite,
  type TimeRangeFavorite,
} from '../../../../utils/favorites';
import { useSettingsStore, type IOProfile } from '../../stores/settingsStore';

export interface UseBookmarkHandlersParams {
  // Form state from useSettingsForms (editing)
  bookmarkName: string;
  bookmarkStartTime: string;
  bookmarkEndTime: string;
  bookmarkMaxFrames: string;
  resetBookmarkForm: () => void;
  initEditBookmarkForm: (
    name: string,
    startTime: string,
    endTime: string,
    maxFrames?: number
  ) => void;
  // Form state from useSettingsForms (creating)
  newBookmarkProfileId: string;
  newBookmarkName: string;
  newBookmarkStartTime: string;
  newBookmarkEndTime: string;
  newBookmarkMaxFrames: string;
  resetNewBookmarkForm: () => void;
  initNewBookmarkForm: (defaultProfileId: string) => void;
  // Available profiles for creating bookmarks
  timeRangeCapableProfiles: IOProfile[];
}

export function useBookmarkHandlers({
  bookmarkName,
  bookmarkStartTime,
  bookmarkEndTime,
  bookmarkMaxFrames,
  resetBookmarkForm,
  initEditBookmarkForm,
  newBookmarkProfileId,
  newBookmarkName,
  newBookmarkStartTime,
  newBookmarkEndTime,
  newBookmarkMaxFrames,
  resetNewBookmarkForm,
  initNewBookmarkForm,
  timeRangeCapableProfiles,
}: UseBookmarkHandlersParams) {
  // Store selectors
  const dialogPayload = useSettingsStore((s) => s.ui.dialogPayload);

  // Store actions
  const loadBookmarks = useSettingsStore((s) => s.loadBookmarks);
  const openDialog = useSettingsStore((s) => s.openDialog);
  const closeDialog = useSettingsStore((s) => s.closeDialog);
  const setDialogPayload = useSettingsStore((s) => s.setDialogPayload);

  // Open edit dialog
  const handleEditBookmark = (bookmark: TimeRangeFavorite) => {
    setDialogPayload({ bookmarkToEdit: bookmark });
    initEditBookmarkForm(
      bookmark.name,
      bookmark.startTime,
      bookmark.endTime,
      bookmark.maxFrames
    );
    openDialog('editBookmark');
  };

  // Confirm edit
  const handleConfirmEditBookmark = async () => {
    const bookmark = dialogPayload.bookmarkToEdit;
    if (!bookmark) return;

    try {
      const maxFramesValue =
        bookmarkMaxFrames === '' ? undefined : Number(bookmarkMaxFrames);

      await updateFavorite(bookmark.id, {
        name: bookmarkName,
        startTime: bookmarkStartTime,
        endTime: bookmarkEndTime,
        maxFrames: maxFramesValue,
      });

      await loadBookmarks();
      closeDialog('editBookmark');
      setDialogPayload({ bookmarkToEdit: null });
      resetBookmarkForm();
    } catch (error) {
      console.error('Failed to update bookmark:', error);
    }
  };

  // Cancel edit
  const handleCancelEditBookmark = () => {
    closeDialog('editBookmark');
    setDialogPayload({ bookmarkToEdit: null });
    resetBookmarkForm();
  };

  // Open delete confirmation dialog
  const handleDeleteBookmark = (bookmark: TimeRangeFavorite) => {
    setDialogPayload({ bookmarkToDelete: bookmark });
    openDialog('deleteBookmark');
  };

  // Confirm deletion
  const handleConfirmDeleteBookmark = async () => {
    const bookmark = dialogPayload.bookmarkToDelete;
    if (!bookmark) return;

    try {
      await deleteFavorite(bookmark.id);
      await loadBookmarks();
      closeDialog('deleteBookmark');
      setDialogPayload({ bookmarkToDelete: null });
    } catch (error) {
      console.error('Failed to delete bookmark:', error);
    }
  };

  // Cancel deletion
  const handleCancelDeleteBookmark = () => {
    closeDialog('deleteBookmark');
    setDialogPayload({ bookmarkToDelete: null });
  };

  // Open create dialog
  const handleNewBookmark = () => {
    const defaultProfileId = timeRangeCapableProfiles[0]?.id || '';
    initNewBookmarkForm(defaultProfileId);
    openDialog('createBookmark');
  };

  // Confirm creation
  const handleConfirmCreateBookmark = async () => {
    if (!newBookmarkProfileId || !newBookmarkName.trim() || !newBookmarkStartTime) {
      return;
    }

    try {
      const maxFramesValue =
        newBookmarkMaxFrames === '' ? undefined : Number(newBookmarkMaxFrames);

      await addFavorite(
        newBookmarkName.trim(),
        newBookmarkProfileId,
        newBookmarkStartTime,
        newBookmarkEndTime,
        maxFramesValue
      );

      await loadBookmarks();
      closeDialog('createBookmark');
      resetNewBookmarkForm();
    } catch (error) {
      console.error('Failed to create bookmark:', error);
    }
  };

  // Cancel creation
  const handleCancelCreateBookmark = () => {
    closeDialog('createBookmark');
    resetNewBookmarkForm();
  };

  return {
    handleEditBookmark,
    handleConfirmEditBookmark,
    handleCancelEditBookmark,
    handleDeleteBookmark,
    handleConfirmDeleteBookmark,
    handleCancelDeleteBookmark,
    handleNewBookmark,
    handleConfirmCreateBookmark,
    handleCancelCreateBookmark,
  };
}

export type BookmarkHandlers = ReturnType<typeof useBookmarkHandlers>;
