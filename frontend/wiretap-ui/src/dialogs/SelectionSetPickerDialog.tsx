// ui/src/dialogs/SelectionSetPickerDialog.tsx
// Dialog for managing and loading selection sets

import { useState, useEffect } from "react";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconMd, flexRowGap2 } from "../styles/spacing";
import { labelSmall, captionMuted, sectionHeaderText } from "../styles/typography";
import { bgSurface } from "../styles";
import Dialog, { DialogBody, DialogFooter } from "../components/Dialog";
import {
  getAllSelectionSets,
  updateSelectionSet,
  deleteSelectionSet,
  selectionSetSize,
  type SelectionSet,
} from "../utils/selectionSets";
import { useSessionStore } from "../stores/sessionStore";
import { Button } from "../components/Button";
import { Input } from "../components/forms";

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
  const { t, i18n } = useTranslation("dialogs");
  const [selectionSets, setSelectionSets] = useState<SelectionSet[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const showAppError = useSessionStore((s) => s.showAppError);

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
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to load selection sets:", err);
      showAppError(t("selectionSetPicker.errors.loadTitle"), t("selectionSetPicker.errors.loadMessage"), msg);
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
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to save selection set:", err);
      showAppError(t("selectionSetPicker.errors.saveTitle"), t("selectionSetPicker.errors.saveMessage"), msg);
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
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to delete selection set:", err);
      showAppError(t("selectionSetPicker.errors.deleteTitle"), t("selectionSetPicker.errors.deleteMessage"), msg);
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
    return new Date(timestamp).toLocaleDateString(i18n.language, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <Dialog
      isOpen={isOpen}
      size="xl"
      onClose={onClose}
      title={t("selectionSetPicker.title")}
      className="h-125"
    >
      <DialogBody padding="none">
        <div className="flex flex-1 min-h-0">
          {/* Left: Selection Set List */}
          <div className="w-1/2 border-r border-default overflow-y-auto">
            {isLoading ? (
              <div className="p-4 text-sm text-muted">{t("selectionSetPicker.loading")}</div>
            ) : selectionSets.length === 0 ? (
              <div className="p-4 text-sm text-muted">
                {t("selectionSetPicker.empty")}
              </div>
            ) : (
              <div className="divide-y divide-default">
                {selectionSets.map((set) => (
                  <button
                    key={set.id}
                    type="button"
                    onClick={() => handleSelectSet(set)}
                    className={`w-full text-left px-3 py-2 hover:bg-hover ${
                      selectedId === set.id
                        ? "bg-info border-l-2 border-blue-500"
                        : ""
                    }`}
                  >
                    <div className={sectionHeaderText}>
                      {set.name}
                    </div>
                    <div className={`${captionMuted} mt-0.5`}>
                      {t("selectionSetPicker.selectedSummary", selectionSetSize(set))}
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
                  <label className={labelSmall}>{t("selectionSetPicker.name")}</label>
                  <Input
                    type="text"
                    value={editForm.name}
                    onChange={(e) =>
                      setEditForm((prev) => ({ ...prev, name: e.target.value }))
                    }
                    size="lg"
                  />
                </div>

                <div className="space-y-1">
                  <label className={labelSmall}>{t("selectionSetPicker.frames")}</label>
                  <div className={`px-3 py-2 text-sm rounded border border-default ${bgSurface} text-secondary`}>
                    {t("selectionSetPicker.selectedSummary", selectionSetSize(selectedSet))}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className={labelSmall}>{t("selectionSetPicker.created")}</label>
                  <div className={`px-3 py-2 text-sm rounded border border-default ${bgSurface} text-secondary`}>
                    {formatDate(selectedSet.createdAt)}
                  </div>
                </div>

                {selectedSet.lastUsedAt && (
                  <div className="space-y-1">
                    <label className={labelSmall}>{t("selectionSetPicker.lastUsed")}</label>
                    <div className={`px-3 py-2 text-sm rounded border border-default ${bgSurface} text-secondary`}>
                      {formatDate(selectedSet.lastUsedAt)}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2">
                  <Button
                    onClick={handleDelete}
                    variant="ghost"
                    tone="danger"
                  >
                    <Trash2 className={iconMd} />
                    {t("common:actions.delete")}
                  </Button>
                  <div className={flexRowGap2}>
                    <Button
                      onClick={handleSave}
                      disabled={isSaving}
                      variant="outline"
                    >
                      {isSaving ? t("selectionSetPicker.saving") : t("common:actions.save")}
                    </Button>
                    <Button
                      onClick={handleLoad}
                      variant="solid"
                      tone="primary"
                    >
                      {t("selectionSetPicker.load")}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted">
                {t("selectionSetPicker.selectPrompt")}
              </div>
            )}
          </div>
        </div>

      </DialogBody>
      {onClear && (
        <DialogFooter>
          <Button onClick={handleClear} variant="outline">
            {t("selectionSetPicker.clear")}
          </Button>
        </DialogFooter>
      )}
    </Dialog>
  );
}
