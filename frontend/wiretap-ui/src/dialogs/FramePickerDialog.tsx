
import { useTranslation } from "react-i18next";
import Dialog, { DialogBody } from "../components/Dialog";
import FramePicker from "../components/FramePicker";
import type { FrameInfo } from "../types/common";
import type { SelectionSet } from "../utils/selectionSets";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  frames: FrameInfo[];
  selectedFrames: Set<string>;
  onToggleFrame: (id: string) => void;
  onBulkSelect: (bus: number | null, select: boolean) => void;
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
  const { t } = useTranslation("dialogs");

  return (
    <Dialog isOpen={isOpen} onClose={onClose} size="sm" title={t("framePicker.title")}>
      <DialogBody className="max-h-[60vh]">
        <FramePicker
          frames={frames}
          selected={selectedFrames}
          onToggle={onToggleFrame}
          onBulkSelect={onBulkSelect}
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
      </DialogBody>
    </Dialog>
  );
}
