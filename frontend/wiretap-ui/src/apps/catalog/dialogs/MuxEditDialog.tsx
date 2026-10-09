// ui/src/apps/catalog/dialogs/MuxEditDialog.tsx

import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import BitPreview from "../../../components/BitPreview";
import { Input, Textarea, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { textMedium } from "../../../styles";
import type { MuxFields } from "../../../types/catalogEdit";
import { previewRanges, useFrameLayout } from "../hooks/useFrameLayout";

export type MuxEditDialogProps = {
  open: boolean;

  /** The mux being edited, or the frame or case a new one is added to. */
  currentMuxPath: string[];

  isAddingNestedMux: boolean;
  isEditingExistingMux: boolean;

  fields: MuxFields;
  setFields: (f: MuxFields) => void;

  onCancel: () => void;
  onSave: () => void;
};

export default function MuxEditDialog({
  open,
  currentMuxPath,
  isAddingNestedMux,
  isEditingExistingMux,
  fields,
  setFields,
  onCancel,
  onSave,
}: MuxEditDialogProps) {
  const title = isAddingNestedMux ? "Add Nested Mux" : isEditingExistingMux ? "Edit Mux" : "Add Mux";
  const layout = useFrameLayout(open ? currentMuxPath : null);

  const bitPreview = layout && (
    <div className="p-4 bg-surface rounded-lg">
      <div className={`${textMedium} mb-3`}>
        Bit Layout Preview ({layout.byteLength} bytes)
      </div>
      <BitPreview
        numBytes={layout.byteLength}
        ranges={previewRanges(layout, true)}
        currentStartBit={fields.start_bit}
        currentBitLength={fields.bit_length}
        interactive
        onRangeSelect={(startBit, bitLength) => setFields({ ...fields, start_bit: startBit, bit_length: bitLength })}
      />
    </div>
  );

  return (
    <Dialog isOpen={open} onClose={onCancel} size="xl" title={title}>
      <DialogBody className="space-y-4">
        {/* Name */}
        <FormField label="Name" variant="default">
          <Input
            size="lg"
            value={fields.name ?? ""}
            onChange={(e) => setFields({ ...fields, name: e.target.value })}
            placeholder="Named from the frame and bits when left blank"
          />
        </FormField>

        {/* Start Bit & Bit Length */}
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Start Bit" required variant="default">
            <Input
              size="lg"
              type="number"
              value={fields.start_bit}
              onChange={(e) => setFields({ ...fields, start_bit: parseInt(e.target.value) || 0 })}
              min={0}
            />
          </FormField>
          <FormField label="Bit Length" required variant="default">
            <Input
              size="lg"
              type="number"
              value={fields.bit_length}
              onChange={(e) => setFields({ ...fields, bit_length: parseInt(e.target.value) || 1 })}
              min={1}
            />
          </FormField>
        </div>

        {/* Bit Preview */}
        {bitPreview}

        {/* Notes */}
        <FormField label="Notes" variant="default">
          <Textarea
            size="lg"
            value={typeof fields.notes === "string" ? fields.notes : fields.notes?.join("\n") ?? ""}
            onChange={(e) => setFields({ ...fields, notes: e.target.value || undefined })}
            placeholder="Optional notes about this mux..."
            rows={2}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
        <PrimaryButton onClick={onSave} disabled={fields.bit_length < 1}>
          OK
        </PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
