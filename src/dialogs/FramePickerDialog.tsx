// ui/src/dialogs/FramePickerDialog.tsx

import { X } from "lucide-react";
import { iconLg } from "../styles/spacing";
import { borderDivider, hoverLight, bgSurface } from "../styles";
import Dialog from "../components/Dialog";
import FramePicker from "../components/FramePicker";
import type { FrameInfo } from "../types/common";
import type { SelectionSet } from "../utils/selectionSets";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  frames: FrameInfo[];
  selectedFrames: Set<number>;
  onToggleFrame: (id: number) => void;
  onBulkSelect: (bus: number | null, select: boolean) => void;
  displayFrameIdFormat: "hex" | "decimal";
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  activeSelectionSetId?: string | null;
  selectionSetDirty?: boolean;
  onSaveSelectionSet?: () => void;
  selectionSets?: SelectionSet[];
  onLoadSelectionSet?: (selectionSet: SelectionSet) => void;
  onClearSelectionSet?: () => void;
  onSaveAsNewSelectionSet?: () => void;
};

export default function FramePickerDialog({
  isOpen,
  onClose,
  frames,
  selectedFrames,
  onToggleFrame,
  onBulkSelect,
  displayFrameIdFormat,
  onSelectAll,
  onDeselectAll,
  activeSelectionSetId,
  selectionSetDirty,
  onSaveSelectionSet,
  selectionSets,
  onLoadSelectionSet,
  onClearSelectionSet,
  onSaveAsNewSelectionSet,
}: Props) {
  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-sm">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        <div className={`p-4 ${borderDivider} flex items-center justify-between`}>
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            Select Frames
          </h2>
          <button
            onClick={onClose}
            className={`p-1 rounded ${hoverLight} transition-colors`}
          >
            <X className={iconLg} />
          </button>
        </div>
        <div className="p-4 max-h-[60vh] overflow-y-auto">
          <FramePicker
            frames={frames}
            selected={selectedFrames}
            onToggle={onToggleFrame}
            onBulkSelect={onBulkSelect}
            displayFrameIdFormat={displayFrameIdFormat}
            onSelectAll={onSelectAll}
            onDeselectAll={onDeselectAll}
            activeSelectionSetId={activeSelectionSetId}
            selectionSetDirty={selectionSetDirty}
            onSaveSelectionSet={onSaveSelectionSet}
            selectionSets={selectionSets}
            onLoadSelectionSet={onLoadSelectionSet}
            onClearSelectionSet={onClearSelectionSet}
            onSaveAsNewSelectionSet={onSaveAsNewSelectionSet}
            defaultExpanded={true}
            noInnerScroll={true}
          />
        </div>
      </div>
    </Dialog>
  );
}
