// ui/src/apps/settings/views/BookmarksView.tsx
import { Bookmark, Edit2, Plus, Trash2 } from "lucide-react";
import { iconMd, iconSm, flexRowGap2 } from "../../../styles/spacing";
import { cardDefault } from "../../../styles/cardStyles";
import { iconButtonHover, iconButtonHoverDanger } from "../../../styles/buttonStyles";
import { PrimaryButton } from "../../../components/forms";
import type { TimeRangeFavorite } from "../../../utils/favorites";
import type { IOProfile } from "../stores/settingsStore";

type BookmarksViewProps = {
  bookmarks: TimeRangeFavorite[];
  ioProfiles: IOProfile[];
  timeRangeCapableProfiles: IOProfile[];
  onEditBookmark: (bookmark: TimeRangeFavorite) => void;
  onDeleteBookmark: (bookmark: TimeRangeFavorite) => void;
  onNewBookmark?: () => void;
};

const formatTimeRange = (bookmark: TimeRangeFavorite) => {
  const start = bookmark.startTime.replace("T", " ");
  const end = bookmark.endTime.replace("T", " ");
  return `${start} → ${end}`;
};

export default function BookmarksView({
  bookmarks,
  ioProfiles,
  timeRangeCapableProfiles,
  onEditBookmark,
  onDeleteBookmark,
  onNewBookmark,
}: BookmarksViewProps) {
  // Group bookmarks by profile
  const bookmarksByProfile = bookmarks.reduce(
    (acc, b) => {
      if (!acc[b.profileId]) {
        acc[b.profileId] = [];
      }
      acc[b.profileId].push(b);
      return acc;
    },
    {} as Record<string, TimeRangeFavorite[]>
  );

  // Get profile name by id
  const getProfileName = (profileId: string) => {
    const profile = ioProfiles.find((p) => p.id === profileId);
    return profile?.name || profileId;
  };

  const canCreate = timeRangeCapableProfiles.length > 0 && onNewBookmark;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">Time Range Bookmarks</h2>
        {canCreate && (
          <PrimaryButton onClick={onNewBookmark}>
            <Plus className={iconSm} />
            New Bookmark
          </PrimaryButton>
        )}
      </div>

      {bookmarks.length === 0 ? (
        <div className="text-center py-12 text-[color:var(--text-muted)]">
          <Bookmark className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No bookmarks saved yet</p>
          <p className="text-sm mt-2">Create bookmarks from the Decoder or Discovery apps</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(bookmarksByProfile).map(([profileId, profileBookmarks]) => (
            <div key={profileId} className="space-y-3">
              <h3 className="text-sm font-medium text-[color:var(--text-muted)]">
                {getProfileName(profileId)}
              </h3>
              <div className="space-y-2">
                {profileBookmarks.map((bookmark) => (
                  <div
                    key={bookmark.id}
                    className={`flex items-center justify-between p-4 ${cardDefault}`}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <h4 className="font-medium text-[color:var(--text-primary)]">{bookmark.name}</h4>
                      </div>
                      <div className="mt-1 text-sm text-[color:var(--text-muted)] font-mono">
                        {formatTimeRange(bookmark)}
                      </div>
                    </div>
                    <div className={flexRowGap2}>
                      <button
                        onClick={() => onEditBookmark(bookmark)}
                        className={iconButtonHover}
                        title="Edit bookmark"
                      >
                        <Edit2 className={`${iconMd} text-[color:var(--text-muted)]`} />
                      </button>
                      <button
                        onClick={() => onDeleteBookmark(bookmark)}
                        className={iconButtonHoverDanger}
                        title="Delete bookmark"
                      >
                        <Trash2 className={`${iconMd} text-[color:var(--text-red)]`} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
