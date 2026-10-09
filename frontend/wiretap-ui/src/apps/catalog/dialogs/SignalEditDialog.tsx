// ui/src/apps/catalog/dialogs/SignalEditDialog.tsx

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { List, X } from "lucide-react";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { Input, Select, Textarea, Checkbox, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { h3, labelSmall } from "../../../styles";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import BitPreview from "../../../components/BitPreview";
import type { SignalFields } from "../../../types/catalogEdit";
import { useCatalogEditorStore } from "../../../stores/catalogEditorStore";
import { defaultByteOrder } from "../model";
import { previewRanges, useFrameLayout } from "../hooks/useFrameLayout";
import EnumEditorDialog from "./EnumEditorDialog";
import { Button } from "../../../components/Button";
import { Badge } from "../../../components/Badge";

export type SignalEditDialogProps = {
  open: boolean;
  /** The frame or mux case that owns the signal. */
  ownerPath: string[];
  fields: SignalFields;
  setFields: (f: SignalFields) => void;
  editingIndex: number | null;
  onCancel: () => void;
  onSave: () => void;
};

export default function SignalEditDialog({
  open,
  ownerPath,
  fields,
  setFields,
  editingIndex,
  onCancel,
  onSave,
}: SignalEditDialogProps) {
  const { t } = useTranslation("catalog");
  const [showEnumEditor, setShowEnumEditor] = useState(false);
  const inheritedByteOrder = useCatalogEditorStore((s) => defaultByteOrder(s.tree.catalog, ownerPath[1]));
  const layout = useFrameLayout(
    open ? (editingIndex === null ? ownerPath : [...ownerPath, "signals", String(editingIndex)]) : null,
  );

  if (!open) {
    return null;
  }

  const isFormatDisabled = (fields.format || "number") !== "number";

  return (
    <Dialog
      isOpen={open}
      onClose={onCancel}
      size="3xl"
      title={editingIndex !== null ? t("signalEdit.editTitle") : t("signalEdit.addTitle")}
    >
      <DialogBody>
        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-4">
            <FormField label={t("signalEdit.name")} required variant="default">
              <Input
                size="lg"
                value={fields.name}
                onChange={(e) => setFields({ ...fields, name: e.target.value })}
              />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField label={t("signalEdit.startBit")} required variant="default">
                <Input
                  size="lg"
                  type="number"
                  value={fields.start_bit}
                  onChange={(e) => setFields({ ...fields, start_bit: parseInt(e.target.value, 10) || 0 })}
                />
              </FormField>
              <FormField label={t("signalEdit.bitLength")} required variant="default">
                <Input
                  size="lg"
                  type="number"
                  value={fields.bit_length}
                  onChange={(e) => setFields({ ...fields, bit_length: parseInt(e.target.value, 10) || 1 })}
                />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label={t("signalEdit.format")} variant="default">
                <Select
                  size="lg"
                  value={fields.format || "number"}
                  onChange={(e) => setFields({ ...fields, format: e.target.value })}
                >
                  <option value="number">{t("signalEdit.formatNumber")}</option>
                  <option value="enum">{t("signalEdit.formatEnum")}</option>
                  <option value="utf8">{t("signalEdit.formatUtf8")}</option>
                  <option value="ascii">{t("signalEdit.formatAscii")}</option>
                  <option value="hex">{t("signalEdit.formatHex")}</option>
                  <option value="unix_time">{t("signalEdit.formatUnixTime")}</option>
                </Select>
              </FormField>
              <div className="flex items-center gap-2 self-end pb-2">
                <Checkbox
                  id="signal-signed"
                  checked={!!fields.signed}
                  disabled={isFormatDisabled}
                  onChange={(e) => setFields({ ...fields, signed: e.target.checked })}
                />
                <label
                  htmlFor="signal-signed"
                  className={`${labelSmall} ${isFormatDisabled ? "text-muted" : ""}`}
                >
                  {t("signalEdit.signed")}
                </label>
              </div>
            </div>

            {fields.format === "enum" && (
              <div>
                <label className={`${labelSmall} mb-2`}>{t("signalEdit.enumValuesLabel")}</label>
                <div className={flexRowGap2}>
                  <Button
                    onClick={() => setShowEnumEditor(true)}
                  >
                    <List className={iconMd} />
                    {fields.enum && Object.keys(fields.enum).length > 0
                      ? t("signalEdit.editEnumWithCount", { count: Object.keys(fields.enum).length })
                      : t("signalEdit.addEnumValues")}
                  </Button>
                  {fields.enum && Object.keys(fields.enum).length > 0 && (
                    <Button
                      onClick={() => setFields({ ...fields, enum: undefined })}
                      variant="ghost"
                      tone="danger"
                      size="lg"
                      title={t("signalEdit.clearTooltip")}
                    >
                      <X className={iconMd} />
                      {t("signalEdit.clear")}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {fields.format !== "enum" && (
              <div className="grid grid-cols-3 gap-3">
                <FormField label={t("signalEdit.factor")} variant="default">
                  <Input
                    size="lg"
                    type="number"
                    step="any"
                    value={fields.factor ?? ""}
                    placeholder={t("signalEdit.factorPlaceholder")}
                    disabled={isFormatDisabled}
                    className={isFormatDisabled ? "opacity-50 cursor-not-allowed" : ""}
                    onChange={(e) => setFields({ ...fields, factor: e.target.value === "" ? undefined : Number(e.target.value) })}
                  />
                </FormField>
                <FormField label={t("signalEdit.offset")} variant="default">
                  <Input
                    size="lg"
                    type="number"
                    step="any"
                    value={fields.offset ?? ""}
                    placeholder={t("signalEdit.offsetPlaceholder")}
                    disabled={isFormatDisabled}
                    className={isFormatDisabled ? "opacity-50 cursor-not-allowed" : ""}
                    onChange={(e) => setFields({ ...fields, offset: e.target.value === "" ? undefined : Number(e.target.value) })}
                  />
                </FormField>
                <FormField label={t("signalEdit.unit")} variant="default">
                  <Input
                    size="lg"
                    value={fields.unit ?? ""}
                    placeholder={t("signalEdit.unitPlaceholder")}
                    onChange={(e) => setFields({ ...fields, unit: e.target.value || undefined })}
                  />
                </FormField>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 items-end">
              <FormField label={t("signalEdit.confidence")} variant="default">
                <Select
                  size="lg"
                  value={fields.confidence || "none"}
                  onChange={(e) => setFields({ ...fields, confidence: e.target.value as SignalFields["confidence"] })}
                >
                  <option value="none">{t("signalEdit.confidenceNone")}</option>
                  <option value="low">{t("signalEdit.confidenceLow")}</option>
                  <option value="medium">{t("signalEdit.confidenceMedium")}</option>
                  <option value="high">{t("signalEdit.confidenceHigh")}</option>
                </Select>
              </FormField>
              <FormField
                label={
                  <span className="inline-flex items-center gap-2">
                    {t("signalEdit.byteOrder")}
                    {!fields.byte_order && inheritedByteOrder && (
                      <Badge tone="primary" size="lg">{t("signalEdit.inheritedBadge")}</Badge>
                    )}
                  </span>
                }
                variant="default"
              >
                <Select
                  size="lg"
                  className={!fields.byte_order ? "text-muted" : ""}
                  value={fields.byte_order || ""}
                  onChange={(e) => setFields({ ...fields, byte_order: e.target.value === "" ? undefined : e.target.value as "little" | "big" })}
                >
                  <option value="">
                    {inheritedByteOrder
                      ? inheritedByteOrder === "little"
                        ? t("signalEdit.inheritOptionLE")
                        : t("signalEdit.inheritOptionBE")
                      : t("signalEdit.byteOrderNotSet")}
                  </option>
                  <option value="little">{t("signalEdit.endianLE")}</option>
                  <option value="big">{t("signalEdit.endianBE")}</option>
                </Select>
              </FormField>
            </div>

            <FormField label={t("signalEdit.notes")} variant="default">
              <Textarea
                size="lg"
                value={typeof fields.notes === "string" ? fields.notes : fields.notes?.join("\n") ?? ""}
                onChange={(e) => setFields({ ...fields, notes: e.target.value || undefined })}
                placeholder={t("signalEdit.notesPlaceholder")}
                rows={2}
              />
            </FormField>
          </div>

          <div>
            <h3 className={`${h3} mb-3`}>{t("signalEdit.bitPreview")}</h3>
            <BitPreview
              numBytes={layout?.byteLength ?? 8}
              ranges={previewRanges(layout, true)}
              currentStartBit={fields.start_bit}
              currentBitLength={fields.bit_length}
              interactive
              onRangeSelect={(s, l) => setFields({ ...fields, start_bit: s, bit_length: l })}
            />
          </div>
        </div>

      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onCancel}>{t("signalEdit.cancel")}</SecondaryButton>
        <PrimaryButton
          onClick={onSave}
          disabled={!fields.name || fields.bit_length < 1}
        >
          {editingIndex !== null ? t("signalEdit.updateButton") : t("signalEdit.addButton")}
        </PrimaryButton>
      </DialogFooter>

      <EnumEditorDialog
        open={showEnumEditor}
        enumValues={fields.enum || {}}
        onSave={(values) => {
          setFields({ ...fields, enum: Object.keys(values).length > 0 ? values : undefined });
          setShowEnumEditor(false);
        }}
        onCancel={() => setShowEnumEditor(false)}
      />
    </Dialog>
  );
}
