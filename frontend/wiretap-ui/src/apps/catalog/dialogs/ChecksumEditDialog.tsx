// ui/src/apps/catalog/dialogs/ChecksumEditDialog.tsx

import Dialog from "../../../components/Dialog";
import { Input, Select, Textarea, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { h2, h3, helpText } from "../../../styles";
import type { TomlNode, ChecksumAlgorithm } from "../types";
import { tomlParse } from "../toml";
import { getFrameByteLengthFromPath } from "../utils";
import { CHECKSUM_ALGORITHMS, resolveByteIndexSync } from "../checksums";

export type ChecksumFields = {
  name: string;
  algorithm: ChecksumAlgorithm;
  start_byte: number;
  byte_length: number;
  endianness?: "little" | "big";
  calc_start_byte: number;
  calc_end_byte: number;
  notes?: string;
};

export type ChecksumEditDialogProps = {
  open: boolean;
  selectedNode: TomlNode;
  catalogContent: string;
  fields: ChecksumFields;
  setFields: (f: ChecksumFields) => void;
  editingIndex: number | null;
  onCancel: () => void;
  onSave: () => void;
};

export default function ChecksumEditDialog({
  open,
  selectedNode,
  catalogContent,
  fields,
  setFields,
  editingIndex,
  onCancel,
  onSave,
}: ChecksumEditDialogProps) {
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

  // Get algorithm info for UI hints
  const selectedAlgorithm = CHECKSUM_ALGORITHMS.find((a) => a.id === fields.algorithm);
  const expectedOutputBytes = selectedAlgorithm?.outputBytes ?? 1;

  return (
    <Dialog isOpen={open} maxWidth="max-w-2xl">
      <div className="p-6 max-h-[90vh] overflow-y-auto">
        <h2 className={`${h2} mb-4`}>
          {editingIndex !== null ? "Edit Checksum" : "Add Checksum"}
        </h2>

        <div className="space-y-4">
          {/* Name */}
          <FormField label="Name" required variant="default">
            <Input
              variant="default"
              value={fields.name}
              onChange={(e) => setFields({ ...fields, name: e.target.value })}
              placeholder="e.g., frame_checksum"
            />
          </FormField>

          {/* Algorithm */}
          <div>
            <FormField label="Algorithm" required variant="default">
              <Select
                variant="default"
                value={fields.algorithm}
                onChange={(e) => {
                  const algo = e.target.value as ChecksumAlgorithm;
                  const algoInfo = CHECKSUM_ALGORITHMS.find((a) => a.id === algo);
                  setFields({
                    ...fields,
                    algorithm: algo,
                    // Auto-adjust byte_length to match algorithm output
                    byte_length: algoInfo?.outputBytes ?? fields.byte_length,
                  });
                }}
              >
                {CHECKSUM_ALGORITHMS.map((algo) => (
                  <option key={algo.id} value={algo.id}>
                    {algo.name} ({algo.outputBytes} byte{algo.outputBytes > 1 ? "s" : ""})
                  </option>
                ))}
              </Select>
            </FormField>
            {selectedAlgorithm && (
              <p className={`mt-1 ${helpText}`}>{selectedAlgorithm.description}</p>
            )}
          </div>

          {/* Checksum Position */}
          <div className="p-4 bg-[var(--status-purple-bg)] rounded-lg">
            <h3 className={`${h3} text-[color:var(--status-purple-text-bold)] mb-3`}>
              Checksum Location
            </h3>
            <p className="text-xs text-[color:var(--status-purple-text)] mb-3">
              Use negative values for positions from end (-1 = last byte, -2 = second-to-last)
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <FormField label="Start Byte" required variant="default">
                  <Input
                    variant="default"
                    type="number"
                    min={-frameLength}
                    max={frameLength - 1}
                    value={fields.start_byte}
                    onChange={(e) => setFields({ ...fields, start_byte: Number(e.target.value) })}
                  />
                </FormField>
                {fields.start_byte < 0 && (
                  <p className="mt-1 text-xs text-[color:var(--text-purple)]">
                    → byte {resolveByteIndexSync(fields.start_byte, frameLength)}
                  </p>
                )}
              </div>
              <div>
                <FormField label="Byte Length" required variant="default">
                  <Input
                    variant="default"
                    type="number"
                    min={1}
                    max={4}
                    value={fields.byte_length}
                    onChange={(e) => setFields({ ...fields, byte_length: Number(e.target.value) || 1 })}
                  />
                </FormField>
                {fields.byte_length !== expectedOutputBytes && (
                  <p className="mt-1 text-xs text-[color:var(--text-amber)]">
                    Algorithm output is {expectedOutputBytes} byte{expectedOutputBytes > 1 ? "s" : ""}
                  </p>
                )}
              </div>
              <FormField label="Endianness" variant="default">
                <Select
                  variant="default"
                  value={fields.endianness || "big"}
                  onChange={(e) =>
                    setFields({ ...fields, endianness: e.target.value as "little" | "big" })
                  }
                  disabled={fields.byte_length === 1}
                >
                  <option value="big">Big Endian</option>
                  <option value="little">Little Endian</option>
                </Select>
              </FormField>
            </div>
          </div>

          {/* Calculation Range */}
          <div className="p-4 bg-[var(--status-info-bg)] rounded-lg">
            <h3 className={`${h3} text-[color:var(--status-info-text-bold)] mb-3`}>
              Calculation Range
            </h3>
            <p className="text-xs text-[color:var(--status-info-text)] mb-3">
              Which bytes are included in the checksum calculation (end byte is exclusive).
              Use negative values for positions from end.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FormField label="Start Byte" required variant="default">
                  <Input
                    variant="default"
                    type="number"
                    min={-frameLength}
                    max={frameLength - 1}
                    value={fields.calc_start_byte}
                    onChange={(e) =>
                      setFields({ ...fields, calc_start_byte: Number(e.target.value) })
                    }
                  />
                </FormField>
                {fields.calc_start_byte < 0 && (
                  <p className="mt-1 text-xs text-[color:var(--text-blue)]">
                    → byte {resolveByteIndexSync(fields.calc_start_byte, frameLength)}
                  </p>
                )}
              </div>
              <div>
                <FormField label="End Byte (exclusive)" required variant="default">
                  <Input
                    variant="default"
                    type="number"
                    min={-frameLength + 1}
                    max={frameLength}
                    value={fields.calc_end_byte}
                    onChange={(e) =>
                      setFields({ ...fields, calc_end_byte: Number(e.target.value) })
                    }
                  />
                </FormField>
                {fields.calc_end_byte < 0 && (
                  <p className="mt-1 text-xs text-[color:var(--text-blue)]">
                    → byte {resolveByteIndexSync(fields.calc_end_byte, frameLength)}
                  </p>
                )}
              </div>
            </div>
            {(() => {
              const resolvedStart = resolveByteIndexSync(fields.calc_start_byte, frameLength);
              const resolvedEnd = resolveByteIndexSync(fields.calc_end_byte, frameLength);
              if (resolvedStart >= resolvedEnd) {
                return (
                  <p className="mt-2 text-xs text-[color:var(--text-red)]">
                    End byte must be greater than start byte (resolved: {resolvedStart} to {resolvedEnd})
                  </p>
                );
              }
              return (
                <p className={`mt-2 ${helpText}`}>
                  Calculating over bytes {resolvedStart} to {resolvedEnd - 1} (
                  {Math.max(0, resolvedEnd - resolvedStart)} bytes total)
                </p>
              );
            })()}
          </div>

          {/* Byte Layout Visualization */}
          <div className="p-4 bg-[var(--bg-surface)] rounded-lg">
            <h3 className={`${h3} mb-3`}>Byte Layout Preview</h3>
            {(() => {
              const resolvedStartByte = resolveByteIndexSync(fields.start_byte, frameLength);
              const resolvedCalcStart = resolveByteIndexSync(fields.calc_start_byte, frameLength);
              const resolvedCalcEnd = resolveByteIndexSync(fields.calc_end_byte, frameLength);

              return (
                <div className="flex flex-wrap gap-1 font-mono text-xs">
                  {Array.from({ length: frameLength }).map((_, i) => {
                    const isChecksumByte =
                      i >= resolvedStartByte && i < resolvedStartByte + fields.byte_length;
                    const isCalcByte =
                      i >= resolvedCalcStart && i < resolvedCalcEnd;

                    let bgClass = "bg-[var(--bg-muted)] text-[color:var(--text-muted)]";
                    if (isChecksumByte) {
                      bgClass = "bg-purple-500 text-white";
                    } else if (isCalcByte) {
                      bgClass = "bg-[var(--bg-blue)] text-[color:var(--text-blue-bold)]";
                    }

                    return (
                      <div
                        key={i}
                        className={`w-7 h-7 flex items-center justify-center rounded ${bgClass}`}
                        title={
                          isChecksumByte
                            ? "Checksum location"
                            : isCalcByte
                              ? "Included in calculation"
                              : `Byte ${i}`
                        }
                      >
                        {i}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            <div className="flex items-center gap-4 mt-2 text-xs text-[color:var(--text-muted)]">
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded bg-purple-500"></div>
                <span>Checksum</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 rounded bg-[var(--bg-blue)]"></div>
                <span>Calculation range</span>
              </div>
            </div>
          </div>

          {/* Notes */}
          <FormField label="Notes" variant="default">
            <Textarea
              variant="default"
              value={fields.notes || ""}
              onChange={(e) => setFields({ ...fields, notes: e.target.value || undefined })}
              placeholder="Optional notes about this checksum..."
              rows={2}
            />
          </FormField>
        </div>

        {/* Action Buttons */}
        <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-[color:var(--border-default)]">
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <PrimaryButton
            onClick={onSave}
            disabled={
              !fields.name.trim() ||
              !fields.algorithm ||
              resolveByteIndexSync(fields.calc_start_byte, frameLength) >= resolveByteIndexSync(fields.calc_end_byte, frameLength)
            }
          >
            {editingIndex !== null ? "Update Checksum" : "Add Checksum"}
          </PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
