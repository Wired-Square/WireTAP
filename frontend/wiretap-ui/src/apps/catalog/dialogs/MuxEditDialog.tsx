// ui/src/apps/catalog/dialogs/MuxEditDialog.tsx

import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("catalog");
  const title = t(isAddingNestedMux ? "muxDialog.addNestedTitle" : isEditingExistingMux ? "muxDialog.editTitle" : "muxDialog.addTitle");
  const layout = useFrameLayout(open ? currentMuxPath : null);

  const bitPreview = layout && (
    <div className="p-4 bg-surface rounded-lg">
      <div className={`${textMedium} mb-3`}>
        {t("muxDialog.layoutPreview", { count: layout.byteLength })}
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
        <FormField label={t("muxDialog.name")} variant="default">
          <Input
            size="lg"
            value={fields.name ?? ""}
            onChange={(e) => setFields({ ...fields, name: e.target.value })}
            placeholder={t("muxDialog.namePlaceholder")}
          />
        </FormField>

        <div className="grid grid-cols-2 gap-4">
          <FormField label={t("muxDialog.startBit")} required variant="default">
            <Input
              size="lg"
              type="number"
              value={fields.start_bit}
              onChange={(e) => setFields({ ...fields, start_bit: parseInt(e.target.value) || 0 })}
              min={0}
            />
          </FormField>
          <FormField label={t("muxDialog.bitLength")} required variant="default">
            <Input
              size="lg"
              type="number"
              value={fields.bit_length}
              onChange={(e) => setFields({ ...fields, bit_length: parseInt(e.target.value) || 1 })}
              min={1}
            />
          </FormField>
        </div>

        {bitPreview}

        <FormField label={t("shared.notes")} variant="default">
          <Textarea
            size="lg"
            value={typeof fields.notes === "string" ? fields.notes : fields.notes?.join("\n") ?? ""}
            onChange={(e) => setFields({ ...fields, notes: e.target.value || undefined })}
            placeholder={t("shared.notesPlaceholderMux")}
            rows={2}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onCancel}>{t("common:actions.cancel")}</SecondaryButton>
        <PrimaryButton onClick={onSave} disabled={(fields.bit_length ?? 0) < 1}>
          {t("common:actions.ok")}
        </PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
