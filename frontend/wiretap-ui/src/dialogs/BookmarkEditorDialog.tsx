// ui/src/dialogs/BookmarkEditorDialog.tsx
// Global bookmark editor dialog for managing and loading time range bookmarks

import { useState, useEffect, useCallback } from "react";
import { Play, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { IOProfile } from "../apps/settings/stores/settingsStore";
import { useSessionStore } from "../stores/sessionStore";
import { iconMd, flexRowGap2 } from "../styles/spacing";
import Dialog, { DialogBody, DialogHeader, DialogTitle } from "../components/Dialog";
import { Input, SecondaryButton, PrimaryButton, DangerButton, Select } from "../components/forms";
import { labelSmall, captionMuted, borderDefault, bgSurface, sectionHeaderText, emptyStateText } from "../styles";
import {
  getAllFavorites,
  updateFavorite,
  deleteFavorite,
  type TimeRangeFavorite,
} from "../utils/favorites";
import TimeBoundsInput, { type TimeBounds } from "../components/TimeBoundsInput";
import { IconButton } from "../components/Button";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  /** Called when a bookmark is loaded */
  onLoad?: (bookmark: TimeRangeFavorite) => void;
  /** Called when bookmarks are modified (so caller can refresh) */
  onBookmarksChanged?: () => void;
  /** Filter bookmarks to only show those for this profile */
  profileId?: string | null;
  /** Profiles available for creating new bookmarks (filtered to time-range capable) */
  availableProfiles?: IOProfile[];
  /** Called when a new bookmark is created */
  onCreateBookmark?: (
    profileId: string,
    name: string,
    startTime: string,
    endTime: string,
    maxFrames?: number
  ) => Promise<void>;
};

export default function BookmarkEditorDialog({
  isOpen,
  onClose,
  onLoad,
  onBookmarksChanged,
  profileId,
  availableProfiles,
  onCreateBookmark,
}: Props) {
  const { t } = useTranslation("dialogs");
  const [bookmarks, setBookmarks] = useState<TimeRangeFavorite[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editTimeBounds, setEditTimeBounds] = useState<TimeBounds>({
    startTime: "",
    endTime: "",
    maxFrames: undefined,
    timezoneMode: "local",
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Create mode state
  const [isCreating, setIsCreating] = useState(false);
  const [createProfileId, setCreateProfileId] = useState("");
  const [createName, setCreateName] = useState("");
  const [createTimeBounds, setCreateTimeBounds] = useState<TimeBounds>({
    startTime: "",
    endTime: "",
    maxFrames: undefined,
    timezoneMode: "local",
  });
  const [isCreatingBookmark, setIsCreatingBookmark] = useState(false);

  // Whether we can show the "New" button
  const canCreate = availableProfiles && availableProfiles.length > 0 && onCreateBookmark;

  const showAppError = useSessionStore((s) => s.showAppError);

  // Default time bounds for reset
  const defaultTimeBounds: TimeBounds = {
    startTime: "",
    endTime: "",
    maxFrames: undefined,
    timezoneMode: "local",
  };

  // Load bookmarks when dialog opens
  useEffect(() => {
    if (isOpen) {
      loadBookmarks();
    } else {
      // Reset state when closing
      setSelectedId(null);
      setEditName("");
      setEditTimeBounds(defaultTimeBounds);
      setIsCreating(false);
      setCreateProfileId("");
      setCreateName("");
      setCreateTimeBounds(defaultTimeBounds);
    }
  }, [isOpen]);

  const loadBookmarks = async () => {
    setIsLoading(true);
    try {
      let all = await getAllFavorites();
      // Filter by profile if provided
      if (profileId) {
        all = all.filter((b) => b.profileId === profileId);
      }
      // Sort by name
      all.sort((a, b) => a.name.localeCompare(b.name));
      setBookmarks(all);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to load bookmarks:", err);
      showAppError(t("bookmarkEditor.errors.loadTitle"), t("bookmarkEditor.errors.loadMessage"), msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectBookmark = (bookmark: TimeRangeFavorite) => {
    setSelectedId(bookmark.id);
    setEditName(bookmark.name);
    setEditTimeBounds({
      startTime: bookmark.startTime,
      endTime: bookmark.endTime,
      maxFrames: bookmark.maxFrames,
      timezoneMode: "local",
    });
  };

  // Time bounds change handlers
  const handleEditTimeBoundsChange = useCallback((bounds: TimeBounds) => {
    setEditTimeBounds(bounds);
  }, []);

  const handleCreateTimeBoundsChange = useCallback((bounds: TimeBounds) => {
    setCreateTimeBounds(bounds);
  }, []);

  const handleSave = async () => {
    if (!selectedId) return;

    setIsSaving(true);
    try {
      await updateFavorite(selectedId, {
        name: editName,
        startTime: editTimeBounds.startTime,
        endTime: editTimeBounds.endTime,
        maxFrames: editTimeBounds.maxFrames,
      });
      await loadBookmarks();
      onBookmarksChanged?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to save bookmark:", err);
      showAppError(t("bookmarkEditor.errors.saveTitle"), t("bookmarkEditor.errors.saveMessage"), msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;

    try {
      await deleteFavorite(selectedId);
      setSelectedId(null);
      setEditName("");
      setEditTimeBounds(defaultTimeBounds);
      await loadBookmarks();
      onBookmarksChanged?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to delete bookmark:", err);
      showAppError(t("bookmarkEditor.errors.deleteTitle"), t("bookmarkEditor.errors.deleteMessage"), msg);
    }
  };

  const handleLoad = () => {
    const bookmark = bookmarks.find((b) => b.id === selectedId);
    if (bookmark && onLoad) {
      onLoad(bookmark);
      onClose();
    }
  };

  const handleStartCreate = () => {
    setSelectedId(null);
    setIsCreating(true);
    // Default to first available profile
    const defaultProfile = availableProfiles?.[0]?.id || "";
    setCreateProfileId(defaultProfile);
    setCreateName("");
    setCreateTimeBounds(defaultTimeBounds);
  };

  const handleCancelCreate = () => {
    setIsCreating(false);
    setCreateProfileId("");
    setCreateName("");
    setCreateTimeBounds(defaultTimeBounds);
  };

  const handleCreate = async () => {
    if (!onCreateBookmark || !createProfileId || !createName.trim() || !createTimeBounds.startTime) {
      return;
    }

    setIsCreatingBookmark(true);
    try {
      await onCreateBookmark(
        createProfileId,
        createName.trim(),
        createTimeBounds.startTime,
        createTimeBounds.endTime,
        createTimeBounds.maxFrames
      );
      await loadBookmarks();
      onBookmarksChanged?.();
      setIsCreating(false);
      setCreateProfileId("");
      setCreateName("");
      setCreateTimeBounds(defaultTimeBounds);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to create bookmark:", err);
      showAppError(t("bookmarkEditor.errors.createTitle"), t("bookmarkEditor.errors.createMessage"), msg);
    } finally {
      setIsCreatingBookmark(false);
    }
  };

  const selectedBookmark = bookmarks.find((b) => b.id === selectedId);

  // Group bookmarks by profile for display (only if not filtering by profile)
  const bookmarksByProfile = profileId
    ? { [profileId]: bookmarks }
    : bookmarks.reduce(
        (acc, b) => {
          if (!acc[b.profileId]) {
            acc[b.profileId] = [];
          }
          acc[b.profileId].push(b);
          return acc;
        },
        {} as Record<string, TimeRangeFavorite[]>
      );

  const formatTimeRange = (bookmark: TimeRangeFavorite) => {
    const start = bookmark.startTime.replace("T", " ");
    const end = bookmark.endTime.replace("T", " ");
    return `${start} → ${end}`;
  };

  return (
    <Dialog isOpen={isOpen} size="xl" onClose={onClose} className="h-125">
      <DialogHeader>
        <div className={flexRowGap2}>
          <DialogTitle>{t("bookmarkEditor.title")}</DialogTitle>
          {canCreate && (
            <IconButton
              onClick={handleStartCreate}
              tone="primary"
              size="sm"
              title={t("bookmarkEditor.newTooltip")}
            >
              <Plus className={iconMd} />
            </IconButton>
          )}
        </div>
      </DialogHeader>
      <DialogBody padding="none" className="flex">
        {/* Left: Bookmark List */}
        <div className={`w-1/2 border-r ${borderDefault} overflow-y-auto`}>
          {isLoading ? (
            <div className={`p-4 ${emptyStateText}`}>{t("bookmarkEditor.loading")}</div>
          ) : bookmarks.length === 0 ? (
            <div className={`p-4 ${emptyStateText}`}>{t("bookmarkEditor.empty")}</div>
          ) : (
            <div className="divide-y divide-default">
              {Object.entries(bookmarksByProfile).map(([pid, profileBookmarks]) => (
                <div key={pid}>
                  {!profileId && (
                    <div className={`px-3 py-2 bg-surface ${labelSmall}`}>
                      {pid}
                    </div>
                  )}
                  {profileBookmarks.map((bookmark) => (
                    <div
                      key={bookmark.id}
                      className={`flex items-center w-full hover:bg-hover ${
                        selectedId === bookmark.id
                          ? "bg-info border-l-2 border-info-text"
                          : ""
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => handleSelectBookmark(bookmark)}
                        className="flex-1 text-left px-3 py-2"
                      >
                        <div className={sectionHeaderText}>
                          {bookmark.name}
                        </div>
                        <div className={`${captionMuted} mt-0.5`}>
                          {formatTimeRange(bookmark)}
                        </div>
                      </button>
                      {onLoad && (
                        <IconButton
                          onClick={(e) => {
                            e.stopPropagation();
                            onLoad(bookmark);
                            onClose();
                          }}
                          title={t("bookmarkEditor.loadTooltip")}
                          tone="primary"
                          className="mr-1"
                        >
                          <Play className={iconMd} />
                        </IconButton>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Edit/Create Form */}
        <div className="w-1/2 p-4">
          {isCreating ? (
            /* Create Form */
            <div className="space-y-4">
              <div className="space-y-1">
                <label className={labelSmall}>{t("bookmarkEditor.profile")}</label>
                <Select
                  value={createProfileId}
                  onChange={(e) => setCreateProfileId(e.target.value)}
                  size="lg"
                >
                  {availableProfiles?.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-1">
                <label className={labelSmall}>{t("bookmarkEditor.name")}</label>
                <Input
                  size="lg"
                  type="text"
                  placeholder={t("bookmarkEditor.namePlaceholder")}
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                />
              </div>

              <TimeBoundsInput
                value={createTimeBounds}
                onChange={handleCreateTimeBoundsChange}
                showBookmarks={false}
              />

              <div className="flex items-center justify-end gap-2 pt-2">
                <SecondaryButton onClick={handleCancelCreate}>
                  {t("common:actions.cancel")}
                </SecondaryButton>
                <PrimaryButton
                  onClick={handleCreate}
                  disabled={isCreatingBookmark || !createName.trim() || !createTimeBounds.startTime}
                >
                  {isCreatingBookmark ? t("bookmarkEditor.creating") : t("common:actions.create")}
                </PrimaryButton>
              </div>
            </div>
          ) : selectedBookmark ? (
            /* Edit Form */
            <div className="space-y-4">
              <div className="space-y-1">
                <label className={labelSmall}>{t("bookmarkEditor.name")}</label>
                <Input
                  size="lg"
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>

              <TimeBoundsInput
                value={editTimeBounds}
                onChange={handleEditTimeBoundsChange}
                showBookmarks={false}
              />

              {!profileId && (
                <div className="space-y-1">
                  <label className={labelSmall}>{t("bookmarkEditor.profile")}</label>
                  <div className={`px-3 py-2 text-sm rounded border ${borderDefault} ${bgSurface} text-secondary`}>
                    {selectedBookmark.profileId}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <DangerButton onClick={handleDelete}>
                  <Trash2 className={iconMd} />
                  {t("common:actions.delete")}
                </DangerButton>
                <div className={flexRowGap2}>
                  <SecondaryButton onClick={handleSave} disabled={isSaving}>
                    {isSaving ? t("bookmarkEditor.saving") : t("common:actions.save")}
                  </SecondaryButton>
                  {onLoad && (
                    <PrimaryButton onClick={handleLoad}>{t("bookmarkEditor.load")}</PrimaryButton>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Empty state */
            <div className="flex items-center justify-center h-full text-sm text-muted">
              {canCreate ? t("bookmarkEditor.selectPromptCanCreate") : t("bookmarkEditor.selectPromptReadOnly")}
            </div>
          )}
        </div>
      </DialogBody>
    </Dialog>
  );
}
