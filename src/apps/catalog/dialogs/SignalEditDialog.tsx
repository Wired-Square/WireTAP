// ui/src/apps/catalog/dialogs/SignalEditDialog.tsx

import { useState } from "react";
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
          {editingIndex !== null ? "Edit Signal" : "Add Signal"}
        </h2>

        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-4">
            <FormField label="Name" required variant="default">
              <Input
                variant="default"
                value={fields.name}
                onChange={(e) => setFields({ ...fields, name: e.target.value })}
              />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Start Bit" required variant="default">
                <Input
                  variant="default"
                  type="number"
                  value={fields.start_bit}
                  onChange={(e) => setFields({ ...fields, start_bit: parseInt(e.target.value, 10) || 0 })}
                />
              </FormField>
              <FormField label="Bit Length" required variant="default">
                <Input
                  variant="default"
                  type="number"
                  value={fields.bit_length}
                  onChange={(e) => setFields({ ...fields, bit_length: parseInt(e.target.value, 10) || 1 })}
                />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Format" variant="default">
                <Select
                  variant="default"
                  value={fields.format || "number"}
                  onChange={(e) => setFields({ ...fields, format: e.target.value })}
                >
                  <option value="number">Number</option>
                  <option value="enum">Enum</option>
                  <option value="utf8">UTF-8</option>
                  <option value="ascii">ASCII</option>
                  <option value="hex">Hex</option>
                  <option value="unix_time">Unix Time</option>
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
                  Signed
                </label>
              </div>
            </div>

            {fields.format === "enum" && (
              <div>
                <label className={`${labelSmall} mb-2`}>Enum Values *</label>
                <div className={flexRowGap2}>
                  <button
                    type="button"
                    onClick={() => setShowEnumEditor(true)}
                    className={`${buttonBase} text-sm`}
                  >
                    <List className={iconMd} />
                    {fields.enum && Object.keys(fields.enum).length > 0
                      ? `Edit Enum (${Object.keys(fields.enum).length} values)`
                      : "Add Enum Values"}
                  </button>
                  {fields.enum && Object.keys(fields.enum).length > 0 && (
                    <button
                      type="button"
                      onClick={() => setFields({ ...fields, enum: undefined })}
                      className="flex items-center gap-1 px-3 py-2 text-sm text-[color:var(--danger)] hover:bg-[var(--danger-bg-subtle)] rounded-lg transition-colors"
                      title="Clear enum values"
                    >
                      <X className={iconMd} />
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}

            {fields.format !== "enum" && (
              <div className="grid grid-cols-3 gap-3">
                <FormField label="Factor" variant="default">
                  <Input
                    variant="default"
                    type="number"
                    step="any"
                    value={fields.factor ?? ""}
                    placeholder="e.g. 0.1"
                    disabled={isFormatDisabled}
                    className={isFormatDisabled ? "opacity-50 cursor-not-allowed" : ""}
                    onChange={(e) => setFields({ ...fields, factor: e.target.value === "" ? undefined : Number(e.target.value) })}
                  />
                </FormField>
                <FormField label="Offset" variant="default">
                  <Input
                    variant="default"
                    type="number"
                    step="any"
                    value={fields.offset ?? ""}
                    placeholder="e.g. -40"
                    disabled={isFormatDisabled}
                    className={isFormatDisabled ? "opacity-50 cursor-not-allowed" : ""}
                    onChange={(e) => setFields({ ...fields, offset: e.target.value === "" ? undefined : Number(e.target.value) })}
                  />
                </FormField>
                <FormField label="Unit" variant="default">
                  <Input
                    variant="default"
                    value={fields.unit ?? ""}
                    placeholder="e.g. °C"
                    onChange={(e) => setFields({ ...fields, unit: e.target.value || undefined })}
                  />
                </FormField>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 items-end">
              <FormField label="Confidence" variant="default">
                <Select
                  variant="default"
                  value={fields.confidence || "none"}
                  onChange={(e) => setFields({ ...fields, confidence: e.target.value })}
                >
                  <option value="none">None</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </Select>
              </FormField>
              <FormField
                label={
                  <span className="inline-flex items-center gap-2">
                    Byte Order
                    {!fields.endianness && inheritedByteOrder && (
                      <span className={badgeInfo}>Inherited</span>
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
                      ? `Inherit (${inheritedByteOrder === "little" ? "Little Endian" : "Big Endian"})`
                      : "Not set"}
                  </option>
                  <option value="little">Little Endian</option>
                  <option value="big">Big Endian</option>
                </Select>
              </FormField>
            </div>

            <FormField label="Notes" variant="default">
              <Textarea
                variant="default"
                value={fields.notes ?? ""}
                onChange={(e) => setFields({ ...fields, notes: e.target.value || undefined })}
                placeholder="Optional notes about this signal..."
                rows={2}
              />
            </FormField>
          </div>

          <div>
            <h3 className={`${h3} mb-3`}>Bit Preview</h3>
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
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <PrimaryButton
            onClick={onSave}
            disabled={!fields.name || fields.bit_length < 1}
          >
            {editingIndex !== null ? "Update" : "Add"} Signal
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
