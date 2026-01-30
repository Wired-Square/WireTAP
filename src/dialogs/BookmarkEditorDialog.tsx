// ui/src/dialogs/BookmarkEditorDialog.tsx
// Global bookmark editor dialog for managing and loading time range bookmarks

import { useState, useEffect } from "react";
import { Play, Plus, Trash2, X } from "lucide-react";
import type { IOProfile } from "../apps/settings/stores/settingsStore";
import { useSettingsStore } from "../apps/settings/stores/settingsStore";
import { iconMd, iconLg, flexRowGap2 } from "../styles/spacing";
import Dialog from "../components/Dialog";
import { Input, SecondaryButton, PrimaryButton, DangerButton } from "../components/forms";
import { h2, labelSmall, captionMuted, borderDefault, bgSecondary, hoverLight, sectionHeaderText } from "../styles";
import {
  getAllFavorites,
  updateFavorite,
  deleteFavorite,
  type TimeRangeFavorite,
} from "../utils/favorites";
import TimezoneBadge, {
  type TimezoneMode,
  convertDatetimeLocal,
} from "../components/TimezoneBadge";

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
  const [bookmarks, setBookmarks] = useState<TimeRangeFavorite[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    startTime: "",
    endTime: "",
    maxFrames: "" as string | number,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Create mode state
  const [isCreating, setIsCreating] = useState(false);
  const [createForm, setCreateForm] = useState({
    profileId: "",
    name: "",
    startTime: "",
    endTime: "",
    maxFrames: "" as string | number,
  });
  const [isCreatingBookmark, setIsCreatingBookmark] = useState(false);

  // Whether we can show the "New" button
  const canCreate = availableProfiles && availableProfiles.length > 0 && onCreateBookmark;

  // Timezone mode state
  const [editTimezoneMode, setEditTimezoneMode] = useState<TimezoneMode>("default");
  const [createTimezoneMode, setCreateTimezoneMode] = useState<TimezoneMode>("default");
  const defaultTz = useSettingsStore((s) => s.display.timezone);

  // Load bookmarks when dialog opens
  useEffect(() => {
    if (isOpen) {
      loadBookmarks();
    } else {
      // Reset state when closing
      setSelectedId(null);
      setEditForm({ name: "", startTime: "", endTime: "", maxFrames: "" });
      setIsCreating(false);
      setCreateForm({ profileId: "", name: "", startTime: "", endTime: "", maxFrames: "" });
      setEditTimezoneMode("default");
      setCreateTimezoneMode("default");
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
      console.error("Failed to load bookmarks:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectBookmark = (bookmark: TimeRangeFavorite) => {
    setSelectedId(bookmark.id);
    setEditTimezoneMode("default");
    setEditForm({
      name: bookmark.name,
      startTime: bookmark.startTime,
      endTime: bookmark.endTime,
      maxFrames: bookmark.maxFrames ?? "",
    });
  };

  // Handle timezone mode change for edit form
  const handleEditTimezoneChange = (newMode: TimezoneMode) => {
    setEditForm((prev) => ({
      ...prev,
      startTime: convertDatetimeLocal(prev.startTime, editTimezoneMode, newMode, defaultTz),
      endTime: convertDatetimeLocal(prev.endTime, editTimezoneMode, newMode, defaultTz),
    }));
    setEditTimezoneMode(newMode);
  };

  // Handle timezone mode change for create form
  const handleCreateTimezoneChange = (newMode: TimezoneMode) => {
    setCreateForm((prev) => ({
      ...prev,
      startTime: convertDatetimeLocal(prev.startTime, createTimezoneMode, newMode, defaultTz),
      endTime: convertDatetimeLocal(prev.endTime, createTimezoneMode, newMode, defaultTz),
    }));
    setCreateTimezoneMode(newMode);
  };

  const handleSave = async () => {
    if (!selectedId) return;

    setIsSaving(true);
    try {
      const maxFramesValue = editForm.maxFrames === "" ? undefined : Number(editForm.maxFrames);
      await updateFavorite(selectedId, {
        name: editForm.name,
        startTime: editForm.startTime,
        endTime: editForm.endTime,
        maxFrames: maxFramesValue,
      });
      await loadBookmarks();
      onBookmarksChanged?.();
    } catch (err) {
      console.error("Failed to save bookmark:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;

    try {
      await deleteFavorite(selectedId);
      setSelectedId(null);
      setEditForm({ name: "", startTime: "", endTime: "", maxFrames: "" });
      await loadBookmarks();
      onBookmarksChanged?.();
    } catch (err) {
      console.error("Failed to delete bookmark:", err);
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
    setCreateForm({
      profileId: defaultProfile,
      name: "",
      startTime: "",
      endTime: "",
      maxFrames: "",
    });
  };

  const handleCancelCreate = () => {
    setIsCreating(false);
    setCreateForm({ profileId: "", name: "", startTime: "", endTime: "", maxFrames: "" });
  };

  const handleCreate = async () => {
    if (!onCreateBookmark || !createForm.profileId || !createForm.name.trim() || !createForm.startTime) {
      return;
    }

    setIsCreatingBookmark(true);
    try {
      const maxFramesValue = createForm.maxFrames === "" ? undefined : Number(createForm.maxFrames);
      await onCreateBookmark(
        createForm.profileId,
        createForm.name.trim(),
        createForm.startTime,
        createForm.endTime,
        maxFramesValue
      );
      await loadBookmarks();
      onBookmarksChanged?.();
      setIsCreating(false);
      setCreateForm({ profileId: "", name: "", startTime: "", endTime: "", maxFrames: "" });
    } catch (err) {
      console.error("Failed to create bookmark:", err);
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
    <Dialog isOpen={isOpen} maxWidth="max-w-2xl">
      <div className="flex flex-col h-[500px]">
        {/* Header */}
        <div className={`flex items-center justify-between px-4 py-3 border-b ${borderDefault}`}>
          <div className={flexRowGap2}>
            <h2 className={h2}>Bookmarks</h2>
            {canCreate && (
              <button
                type="button"
                onClick={handleStartCreate}
                className={`p-1 rounded text-[color:var(--text-muted)] hover:text-[color:var(--status-info-text)] ${hoverLight}`}
                title="New bookmark"
              >
                <Plus className={iconMd} />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`p-1 rounded text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)] ${hoverLight}`}
          >
            <X className={iconLg} />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-1 min-h-0">
          {/* Left: Bookmark List */}
          <div className={`w-1/2 border-r ${borderDefault} overflow-y-auto`}>
            {isLoading ? (
              <div className="p-4 text-sm text-slate-400">Loading...</div>
            ) : bookmarks.length === 0 ? (
              <div className="p-4 text-sm text-slate-400">
                No bookmarks saved yet.
              </div>
            ) : (
              <div className="divide-y divide-[color:var(--border-default)]">
                {Object.entries(bookmarksByProfile).map(([pid, profileBookmarks]) => (
                  <div key={pid}>
                    {!profileId && (
                      <div className={`px-3 py-2 bg-[var(--bg-surface)] ${labelSmall}`}>
                        {pid}
                      </div>
                    )}
                    {profileBookmarks.map((bookmark) => (
                      <div
                        key={bookmark.id}
                        className={`flex items-center w-full hover:bg-[var(--hover-bg)] ${
                          selectedId === bookmark.id
                            ? "bg-[var(--status-info-bg)] border-l-2 border-[color:var(--status-info-text)]"
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
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onLoad(bookmark);
                              onClose();
                            }}
                            title="Load bookmark"
                            className="p-2 mr-1 rounded text-[color:var(--text-muted)] hover:text-[color:var(--status-info-text)] hover:bg-[var(--status-info-bg)]"
                          >
                            <Play className={iconMd} />
                          </button>
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
                  <label className={labelSmall}>Profile</label>
                  <select
                    value={createForm.profileId}
                    onChange={(e) =>
                      setCreateForm((prev) => ({ ...prev, profileId: e.target.value }))
                    }
                    className={`w-full px-3 py-2 text-sm rounded border ${borderDefault} bg-[var(--bg-surface)] text-[color:var(--text-primary)]`}
                  >
                    {availableProfiles?.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className={labelSmall}>Name</label>
                  <Input
                    variant="simple"
                    type="text"
                    placeholder="Bookmark name"
                    value={createForm.name}
                    onChange={(e) =>
                      setCreateForm((prev) => ({ ...prev, name: e.target.value }))
                    }
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <label className={labelSmall}>From</label>
                    <TimezoneBadge mode={createTimezoneMode} onChange={handleCreateTimezoneChange} />
                  </div>
                  <Input
                    variant="simple"
                    type="datetime-local"
                    step="1"
                    value={createForm.startTime}
                    onChange={(e) =>
                      setCreateForm((prev) => ({ ...prev, startTime: e.target.value }))
                    }
                  />
                </div>

                <div className="space-y-1">
                  <label className={labelSmall}>To</label>
                  <Input
                    variant="simple"
                    type="datetime-local"
                    step="1"
                    value={createForm.endTime}
                    onChange={(e) =>
                      setCreateForm((prev) => ({ ...prev, endTime: e.target.value }))
                    }
                  />
                </div>

                <div className="space-y-1">
                  <label className={labelSmall}>Max Frames</label>
                  <Input
                    variant="simple"
                    type="number"
                    min={0}
                    placeholder="No limit"
                    value={createForm.maxFrames}
                    onChange={(e) =>
                      setCreateForm((prev) => ({ ...prev, maxFrames: e.target.value }))
                    }
                  />
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <SecondaryButton onClick={handleCancelCreate}>
                    Cancel
                  </SecondaryButton>
                  <PrimaryButton
                    onClick={handleCreate}
                    disabled={isCreatingBookmark || !createForm.name.trim() || !createForm.startTime}
                  >
                    {isCreatingBookmark ? "Creating..." : "Create"}
                  </PrimaryButton>
                </div>
              </div>
            ) : selectedBookmark ? (
              /* Edit Form */
              <div className="space-y-4">
                <div className="space-y-1">
                  <label className={labelSmall}>Name</label>
                  <Input
                    variant="simple"
                    type="text"
                    value={editForm.name}
                    onChange={(e) =>
                      setEditForm((prev) => ({ ...prev, name: e.target.value }))
                    }
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <label className={labelSmall}>From</label>
                    <TimezoneBadge mode={editTimezoneMode} onChange={handleEditTimezoneChange} />
                  </div>
                  <Input
                    variant="simple"
                    type="datetime-local"
                    step="1"
                    value={editForm.startTime}
                    onChange={(e) =>
                      setEditForm((prev) => ({ ...prev, startTime: e.target.value }))
                    }
                  />
                </div>

                <div className="space-y-1">
                  <label className={labelSmall}>To</label>
                  <Input
                    variant="simple"
                    type="datetime-local"
                    step="1"
                    value={editForm.endTime}
                    onChange={(e) =>
                      setEditForm((prev) => ({ ...prev, endTime: e.target.value }))
                    }
                  />
                </div>

                <div className="space-y-1">
                  <label className={labelSmall}>Max Frames</label>
                  <Input
                    variant="simple"
                    type="number"
                    min={0}
                    placeholder="No limit"
                    value={editForm.maxFrames}
                    onChange={(e) =>
                      setEditForm((prev) => ({ ...prev, maxFrames: e.target.value }))
                    }
                  />
                </div>

                {!profileId && (
                  <div className="space-y-1">
                    <label className={labelSmall}>Profile</label>
                    <div className={`px-3 py-2 text-sm rounded border ${borderDefault} ${bgSecondary} text-[color:var(--text-secondary)]`}>
                      {selectedBookmark.profileId}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2">
                  <DangerButton onClick={handleDelete}>
                    <Trash2 className={iconMd} />
                    Delete
                  </DangerButton>
                  <div className={flexRowGap2}>
                    <SecondaryButton onClick={handleSave} disabled={isSaving}>
                      {isSaving ? "Saving..." : "Save"}
                    </SecondaryButton>
                    {onLoad && (
                      <PrimaryButton onClick={handleLoad}>Load</PrimaryButton>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              /* Empty state */
              <div className="flex items-center justify-center h-full text-sm text-slate-400">
                {canCreate ? "Select a bookmark or click + to create one" : "Select a bookmark to edit or load"}
              </div>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
