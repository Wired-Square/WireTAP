// ui/src/apps/catalog/dialogs/SignalEditDialog.tsx

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { List, X } from "lucide-react";
import Dialog from "../../../components/Dialog";
import { Input, Select, Textarea, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { h2, h3, labelSmall, badgeInfo } from "../../../styles";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { buttonBase } from "../../../styles/buttonStyles";
import BitPreview, { BitRange } from "../../../components/BitPreview";
import type { TomlNode } from "../types";
import { tomlParse } from "../toml";
import { extractMuxRangesFromPath, getFrameByteLengthFromPath } from "../utils";
import EnumEditorDialog from "./EnumEditorDialog";

export type SignalFields = {
  name: string;
  start_bit: number;
  bit_length: number;
  factor?: number;
  offset?: number;
  unit?: string;
  signed?: boolean;
  endianness?: "little" | "big";
  min?: number;
  max?: number;
  format?: string;
  confidence?: string;
  enum?: Record<string, string>;
  notes?: string;
};

export type SignalEditDialogProps = {
  open: boolean;
  selectedNode: TomlNode;
  catalogContent: string;
  fields: SignalFields;
  setFields: (f: SignalFields) => void;
  editingIndex: number | null;
  inheritedByteOrder?: "little" | "big";
  onCancel: () => void;
  onSave: () => void;
};

export default function SignalEditDialog({
  open,
  selectedNode,
  catalogContent,
  fields,
  setFields,
  editingIndex,
  inheritedByteOrder,
  onCancel,
  onSave,
}: SignalEditDialogProps) {
  const { t } = useTranslation("catalog");
  const [showEnumEditor, setShowEnumEditor] = useState(false);

  // Early return if not open or no selected node - prevents errors when dialog is closed
  if (!open || !selectedNode) {
    return null;
  }

  // Parse the catalog content to get frame info
  let parsed: any;
  try {
    parsed = tomlParse(catalogContent);
  } catch {
    parsed = null;
  }

  // Get frame length using protocol-aware utility (handles CAN, Modbus, Serial)
  const frameLength = parsed
    ? getFrameByteLengthFromPath(selectedNode.path, parsed)
    : (selectedNode.metadata?.length || 8);

  const existingSignals = selectedNode.metadata?.signals?.filter((_: any, i: number) => i !== editingIndex) || [];

  const ranges: BitRange[] = [];

  existingSignals.forEach((s: any) => {
    ranges.push({
      name: s.name || "Signal",
      start_bit: s.start_bit || 0,
      bit_length: s.bit_length || 8,
      type: "signal",
    });
  });

  try {
    if (!parsed) throw new Error("No parsed content");
    const protocol = selectedNode.path[1];
    const frameKey = selectedNode.path[2];
    const frame = parsed?.frame?.[protocol]?.[frameKey];

    // Extract all mux ranges from the path hierarchy (handles nested muxes)
    const muxRanges = extractMuxRangesFromPath(selectedNode.path, parsed);
    ranges.push(...muxRanges);

    // When adding/editing inside a mux case, also show frame-level signals so bit usage stays visible.
    const isInsideMuxCase = selectedNode.path.includes("mux");
    const addSignalRange = (signal: any) => {
      const start = signal.start_bit || 0;
      const length = signal.bit_length || 8;
      // avoid duplicate entries when metadata already supplied the same signal
      const alreadyPresent = ranges.some(
        (r) => r.type === "signal" && r.start_bit === start && r.bit_length === length && r.name === (signal.name || "Signal")
      );
      if (!alreadyPresent) {
        ranges.push({
          name: signal.name || "Signal",
          start_bit: start,
          bit_length: length,
          type: "signal",
        });
      }
    };

    if (isInsideMuxCase) {
      // Add frame-level signals
      if (frame?.signals) {
        frame.signals.forEach(addSignalRange);
      }

      // Traverse path to add signals from all mux cases in hierarchy
      let currentObj = frame;
      for (let i = 3; i < selectedNode.path.length; i++) {
        const segment = selectedNode.path[i];
        if (segment === "mux") {
          currentObj = currentObj?.mux;
          i++;
          if (i < selectedNode.path.length && currentObj) {
            const caseKey = selectedNode.path[i];
            const caseObj = currentObj[caseKey] || currentObj.cases?.[caseKey];
            if (caseObj) {
              const caseSignals = caseObj.signals || [];
              // Check if this is the level we're editing
              const nextSegment = selectedNode.path[i + 1];
              const isEditingLevel = nextSegment === "signals" || nextSegment === "signal";
              caseSignals
                .filter((_: any, idx: number) => !(isEditingLevel && idx === editingIndex))
                .forEach(addSignalRange);
              currentObj = caseObj;
            }
          }
        } else if (segment === "signals" || segment === "signal") {
          break;
        }
      }
    }
  } catch {}

  const isFormatDisabled = (fields.format || "number") !== "number";

  return (
    <Dialog isOpen={open} maxWidth="max-w-7xl">
      <div className="p-6 max-h-[90vh] overflow-y-auto">
        <h2 className={`${h2} mb-4`}>
          {editingIndex !== null ? t("signalEdit.editTitle") : t("signalEdit.addTitle")}
        </h2>

        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-4">
            <FormField label={t("signalEdit.name")} required variant="default">
              <Input
                variant="default"
                value={fields.name}
                onChange={(e) => setFields({ ...fields, name: e.target.value })}
              />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField label={t("signalEdit.startBit")} required variant="default">
                <Input
                  variant="default"
                  type="number"
                  value={fields.start_bit}
                  onChange={(e) => setFields({ ...fields, start_bit: parseInt(e.target.value, 10) || 0 })}
                />
              </FormField>
              <FormField label={t("signalEdit.bitLength")} required variant="default">
                <Input
                  variant="default"
                  type="number"
                  value={fields.bit_length}
                  onChange={(e) => setFields({ ...fields, bit_length: parseInt(e.target.value, 10) || 1 })}
                />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label={t("signalEdit.format")} variant="default">
                <Select
                  variant="default"
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
                <input
                  id="signal-signed"
                  type="checkbox"
                  checked={!!fields.signed}
                  disabled={isFormatDisabled}
                  className={isFormatDisabled ? "opacity-50 cursor-not-allowed" : ""}
                  onChange={(e) => setFields({ ...fields, signed: e.target.checked })}
                />
                <label
                  htmlFor="signal-signed"
                  className={`${labelSmall} ${isFormatDisabled ? "text-[color:var(--text-muted)]" : ""}`}
                >
                  {t("signalEdit.signed")}
                </label>
              </div>
            </div>

            {fields.format === "enum" && (
              <div>
                <label className={`${labelSmall} mb-2`}>{t("signalEdit.enumValuesLabel")}</label>
                <div className={flexRowGap2}>
                  <button
                    type="button"
                    onClick={() => setShowEnumEditor(true)}
                    className={`${buttonBase} text-sm`}
                  >
                    <List className={iconMd} />
                    {fields.enum && Object.keys(fields.enum).length > 0
                      ? t("signalEdit.editEnumWithCount", { count: Object.keys(fields.enum).length })
                      : t("signalEdit.addEnumValues")}
                  </button>
                  {fields.enum && Object.keys(fields.enum).length > 0 && (
                    <button
                      type="button"
                      onClick={() => setFields({ ...fields, enum: undefined })}
                      className="flex items-center gap-1 px-3 py-2 text-sm text-[color:var(--danger)] hover:bg-[var(--danger-bg-subtle)] rounded-lg transition-colors"
                      title={t("signalEdit.clearTooltip")}
                    >
                      <X className={iconMd} />
                      {t("signalEdit.clear")}
                    </button>
                  )}
                </div>
              </div>
            )}

            {fields.format !== "enum" && (
              <div className="grid grid-cols-3 gap-3">
                <FormField label={t("signalEdit.factor")} variant="default">
                  <Input
                    variant="default"
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
                    variant="default"
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
                    variant="default"
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
                  variant="default"
                  value={fields.confidence || "none"}
                  onChange={(e) => setFields({ ...fields, confidence: e.target.value })}
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
                    {!fields.endianness && inheritedByteOrder && (
                      <span className={badgeInfo}>{t("signalEdit.inheritedBadge")}</span>
                    )}
                  </span>
                }
                variant="default"
              >
                <Select
                  variant="default"
                  className={!fields.endianness ? "text-[color:var(--text-muted)]" : ""}
                  value={fields.endianness || ""}
                  onChange={(e) => setFields({ ...fields, endianness: e.target.value === "" ? undefined : e.target.value as "little" | "big" })}
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
                variant="default"
                value={fields.notes ?? ""}
                onChange={(e) => setFields({ ...fields, notes: e.target.value || undefined })}
                placeholder={t("signalEdit.notesPlaceholder")}
                rows={2}
              />
            </FormField>
          </div>

          <div>
            <h3 className={`${h3} mb-3`}>{t("signalEdit.bitPreview")}</h3>
            <BitPreview
              numBytes={frameLength}
              ranges={ranges}
              currentStartBit={fields.start_bit}
              currentBitLength={fields.bit_length}
              interactive
              onRangeSelect={(s, l) => setFields({ ...fields, start_bit: s, bit_length: l })}
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <SecondaryButton onClick={onCancel}>{t("signalEdit.cancel")}</SecondaryButton>
          <PrimaryButton
            onClick={onSave}
            disabled={!fields.name || fields.bit_length < 1}
          >
            {editingIndex !== null ? t("signalEdit.updateButton") : t("signalEdit.addButton")}
          </PrimaryButton>
        </div>
      </div>

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
