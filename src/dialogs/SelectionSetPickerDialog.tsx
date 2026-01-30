// ui/src/dialogs/SelectionSetPickerDialog.tsx
// Dialog for managing and loading selection sets

import { useState, useEffect } from "react";
import { Trash2, X } from "lucide-react";
import { iconMd, iconLg, flexRowGap2 } from "../styles/spacing";
import { labelSmall, captionMuted, sectionHeaderText } from "../styles/typography";
import { borderDivider, bgSecondary, hoverLight } from "../styles";
import Dialog from "../components/Dialog";
import {
  getAllSelectionSets,
  updateSelectionSet,
  deleteSelectionSet,
  type SelectionSet,
} from "../utils/selectionSets";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onLoad: (selectionSet: SelectionSet) => void;
  /** Called when the user wants to clear the active selection set */
  onClear?: () => void;
  /** Called when selection sets are modified (so caller can refresh) */
  onSelectionSetsChanged?: () => void;
};

export default function SelectionSetPickerDialog({
  isOpen,
  onClose,
  onLoad,
  onClear,
  onSelectionSetsChanged,
}: Props) {
  const [selectionSets, setSelectionSets] = useState<SelectionSet[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Load selection sets when dialog opens
  useEffect(() => {
    if (isOpen) {
      loadSelectionSets();
    } else {
      // Reset state when closing
      setSelectedId(null);
      setEditForm({ name: "" });
    }
  }, [isOpen]);

  const loadSelectionSets = async () => {
    setIsLoading(true);
    try {
      const all = await getAllSelectionSets();
      // Sort by name
      all.sort((a, b) => a.name.localeCompare(b.name));
      setSelectionSets(all);
    } catch (err) {
      console.error("Failed to load selection sets:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectSet = (set: SelectionSet) => {
    setSelectedId(set.id);
    setEditForm({
      name: set.name,
    });
  };

  const handleSave = async () => {
    if (!selectedId) return;

    setIsSaving(true);
    try {
      await updateSelectionSet(selectedId, {
        name: editForm.name,
      });
      await loadSelectionSets();
      onSelectionSetsChanged?.();
    } catch (err) {
      console.error("Failed to save selection set:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;

    try {
      await deleteSelectionSet(selectedId);
      setSelectedId(null);
      setEditForm({ name: "" });
      await loadSelectionSets();
      onSelectionSetsChanged?.();
    } catch (err) {
      console.error("Failed to delete selection set:", err);
    }
  };

  const handleLoad = () => {
    const set = selectionSets.find((s) => s.id === selectedId);
    if (set) {
      onLoad(set);
      onClose();
    }
  };

  const handleClear = () => {
    onClear?.();
    onClose();
  };

  const selectedSet = selectionSets.find((s) => s.id === selectedId);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-2xl">
      <div className="flex flex-col h-[500px]">
        {/* Header */}
        <div className={`flex items-center justify-between px-4 py-3 ${borderDivider}`}>
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            Selection Sets
          </h2>
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
          {/* Left: Selection Set List */}
          <div className="w-1/2 border-r border-[color:var(--border-default)] overflow-y-auto">
            {isLoading ? (
              <div className="p-4 text-sm text-[color:var(--text-muted)]">Loading...</div>
            ) : selectionSets.length === 0 ? (
              <div className="p-4 text-sm text-[color:var(--text-muted)]">
                No selection sets saved yet.
              </div>
            ) : (
              <div className="divide-y divide-[color:var(--border-default)]">
                {selectionSets.map((set) => (
                  <button
                    key={set.id}
                    type="button"
                    onClick={() => handleSelectSet(set)}
                    className={`w-full text-left px-3 py-2 hover:bg-[var(--hover-bg)] ${
                      selectedId === set.id
                        ? "bg-[var(--status-info-bg)] border-l-2 border-blue-500"
                        : ""
                    }`}
                  >
                    <div className={sectionHeaderText}>
                      {set.name}
                    </div>
                    <div className={`${captionMuted} mt-0.5`}>
                      {set.selectedIds?.length ?? set.frameIds.length}/{set.frameIds.length} selected
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Right: Edit Form */}
          <div className="w-1/2 p-4">
            {selectedSet ? (
              <div className="space-y-4">
                <div className="space-y-1">
                  <label className={labelSmall}>
                    Name
                  </label>
                  <input
                    type="text"
                    value={editForm.name}
                    onChange={(e) =>
                      setEditForm((prev) => ({ ...prev, name: e.target.value }))
                    }
                    className="w-full px-3 py-2 text-sm rounded border border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-primary)]"
                  />
                </div>

                <div className="space-y-1">
                  <label className={labelSmall}>
                    Frames
                  </label>
                  <div className={`px-3 py-2 text-sm rounded border border-[color:var(--border-default)] ${bgSecondary} text-[color:var(--text-secondary)]`}>
                    {selectedSet.selectedIds?.length ?? selectedSet.frameIds.length}/{selectedSet.frameIds.length} selected
                  </div>
                </div>

                <div className="space-y-1">
                  <label className={labelSmall}>
                    Created
                  </label>
                  <div className={`px-3 py-2 text-sm rounded border border-[color:var(--border-default)] ${bgSecondary} text-[color:var(--text-secondary)]`}>
                    {formatDate(selectedSet.createdAt)}
                  </div>
                </div>

                {selectedSet.lastUsedAt && (
                  <div className="space-y-1">
                    <label className={labelSmall}>
                      Last Used
                    </label>
                    <div className={`px-3 py-2 text-sm rounded border border-[color:var(--border-default)] ${bgSecondary} text-[color:var(--text-secondary)]`}>
                      {formatDate(selectedSet.lastUsedAt)}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2">
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded text-[color:var(--status-danger-text)] hover:bg-[var(--status-danger-bg)]"
                  >
                    <Trash2 className={iconMd} />
                    Delete
                  </button>
                  <div className={flexRowGap2}>
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={isSaving}
                      className={`px-4 py-1.5 text-sm font-medium rounded border border-[color:var(--border-default)] text-[color:var(--text-primary)] ${hoverLight} disabled:opacity-50`}
                    >
                      {isSaving ? "Saving..." : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={handleLoad}
                      className="px-4 py-1.5 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
                    >
                      Load
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-[color:var(--text-muted)]">
                Select a set to edit or load
              </div>
            )}
          </div>
        </div>

        {/* Footer with Clear button */}
        {onClear && (
          <div className="flex items-center justify-end px-4 py-3 border-t border-[color:var(--border-default)]">
            <button
              type="button"
              onClick={handleClear}
              className={`px-4 py-1.5 text-sm font-medium rounded border border-[color:var(--border-default)] text-[color:var(--text-primary)] ${hoverLight}`}
            >
              Clear Selection Set
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
