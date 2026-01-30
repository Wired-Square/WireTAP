// ui/src/apps/catalog/dialogs/MuxEditDialog.tsx

import Dialog from "../../../components/Dialog";
import BitPreview, { BitRange } from "../../../components/BitPreview";
import { Input, Textarea, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { h2, textMedium } from "../../../styles";
import { tomlParse } from "../toml";
import { getFrameByteLengthFromPath } from "../utils";

export type MuxFields = {
  name: string;
  start_bit: number;
  bit_length: number;
  notes?: string;
};

export type MuxEditDialogProps = {
  open: boolean;

  catalogContent: string;
  currentMuxPath: string[];

  isAddingNestedMux: boolean;
  isEditingExistingMux: boolean;

  fields: MuxFields;
  setFields: (f: MuxFields) => void;

  generateMuxName: (muxPath: string[], startBit: number, bitLength: number, isNested: boolean) => string;

  onCancel: () => void;
  onSave: () => void;
};

export default function MuxEditDialog({
  open,
  catalogContent,
  currentMuxPath,
  isAddingNestedMux,
  isEditingExistingMux,
  fields,
  setFields,
  generateMuxName,
  onCancel,
  onSave,
}: MuxEditDialogProps) {
  const title = isAddingNestedMux ? "Add Nested Mux" : isEditingExistingMux ? "Edit Mux" : "Add Mux";

  const bitPreview = (() => {
    try {
      const parsed = tomlParse(catalogContent) as any;

      // currentMuxPath is either ['frame','can','0x123'] (top level mux)
      // or a mux-case path, e.g. ['frame','can','0x123','mux','2'] (nested mux)
      const protocol = currentMuxPath[1];
      const frameKey = currentMuxPath[2];

      // Get frame byte length (handles CAN, Modbus, Serial)
      const frameLength = getFrameByteLengthFromPath(currentMuxPath, parsed);

      const ranges: BitRange[] = [];
      const frame = parsed.frame?.[protocol]?.[frameKey];
      const signals = frame?.signals || [];
      const existingMux = frame?.mux;

      // Show existing mux if we're *adding* a mux (not editing one)
      if (existingMux && !isEditingExistingMux) {
        ranges.push({
          name: existingMux.name || "Mux",
          start_bit: existingMux.start_bit || 0,
          bit_length: existingMux.bit_length || 8,
          type: "mux",
        });
      }

      // Signals
      signals.forEach((signal: any) => {
        ranges.push({
          name: signal.name || "Signal",
          start_bit: signal.start_bit || 0,
          bit_length: signal.bit_length || 8,
          type: "signal",
        });
      });

      return (
        <div className="p-4 bg-[var(--bg-surface)] rounded-lg">
          <div className={`${textMedium} mb-3`}>
            Bit Layout Preview ({frameLength} bytes)
          </div>
          <BitPreview
            numBytes={frameLength}
            ranges={ranges}
            currentStartBit={fields.start_bit}
            currentBitLength={fields.bit_length}
            interactive
            onRangeSelect={(startBit, bitLength) => {
              const newName = generateMuxName(currentMuxPath, startBit, bitLength, isAddingNestedMux);
              setFields({
                ...fields,
                start_bit: startBit,
                bit_length: bitLength,
                name: newName,
              });
            }}
          />
        </div>
      );
    } catch {
      return null;
    }
  })();

  return (
    <Dialog isOpen={open} maxWidth="max-w-2xl">
      <div className="p-6 max-h-[90vh] overflow-y-auto">
        <h2 className={`${h2} mb-6`}>{title}</h2>

        <div className="space-y-4">
          {/* Name */}
          <FormField label="Name" required variant="default">
            <Input
              variant="default"
              value={fields.name}
              onChange={(e) => setFields({ ...fields, name: e.target.value })}
              placeholder="selector_name"
            />
          </FormField>

          {/* Start Bit & Bit Length */}
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Start Bit" required variant="default">
              <Input
                variant="default"
                type="number"
                value={fields.start_bit}
                onChange={(e) => {
                  const newStartBit = parseInt(e.target.value) || 0;
                  const newName = generateMuxName(currentMuxPath, newStartBit, fields.bit_length, isAddingNestedMux);
                  setFields({ ...fields, start_bit: newStartBit, name: newName });
                }}
                min={0}
              />
            </FormField>
            <FormField label="Bit Length" required variant="default">
              <Input
                variant="default"
                type="number"
                value={fields.bit_length}
                onChange={(e) => {
                  const newBitLength = parseInt(e.target.value) || 1;
                  const newName = generateMuxName(currentMuxPath, fields.start_bit, newBitLength, isAddingNestedMux);
                  setFields({ ...fields, bit_length: newBitLength, name: newName });
                }}
                min={1}
              />
            </FormField>
          </div>

          {/* Bit Preview */}
          {bitPreview}

          {/* Notes */}
          <FormField label="Notes" variant="default">
            <Textarea
              variant="default"
              value={fields.notes ?? ""}
              onChange={(e) => setFields({ ...fields, notes: e.target.value || undefined })}
              placeholder="Optional notes about this mux..."
              rows={2}
            />
          </FormField>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <PrimaryButton onClick={onSave} disabled={!fields.name || fields.bit_length < 1}>
            OK
          </PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
