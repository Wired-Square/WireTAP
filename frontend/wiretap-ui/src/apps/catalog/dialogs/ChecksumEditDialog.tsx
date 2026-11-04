// ui/src/apps/catalog/dialogs/ChecksumEditDialog.tsx

import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { useTranslation } from "react-i18next";
import { Input, Select, Textarea, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { h3, helpText } from "../../../styles";
import type { TomlNode, ChecksumAlgorithm } from "../types";
import { useCatalogEditorStore } from "../../../stores/catalogEditorStore";
import { frameAt } from "../model";
import { CHECKSUM_ALGORITHMS } from "../checksums";
import { useResolvedByteIndices } from "../../../hooks/useResolvedByteIndices";
import { Card } from "../../../components/Card";
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
  fields: ChecksumFields;
  setFields: (f: ChecksumFields) => void;
  editingIndex: number | null;
  onCancel: () => void;
  onSave: () => void;
};

export default function ChecksumEditDialog({
  open,
  selectedNode,
  fields,
  setFields,
  editingIndex,
  onCancel,
  onSave,
}: ChecksumEditDialogProps) {
  const { t } = useTranslation("catalog");
  const frameLength = useCatalogEditorStore((s) => (selectedNode && frameAt(s.tree.catalog, selectedNode.path)?.length) || 8);
  const resolve = useResolvedByteIndices([fields.start_byte, fields.calc_start_byte, fields.calc_end_byte], [frameLength]);

  if (!open || !selectedNode) {
    return null;
  }

  const checksumStart = resolve(fields.start_byte, frameLength);
  const calcStart = resolve(fields.calc_start_byte, frameLength);
  const calcEnd = resolve(fields.calc_end_byte, frameLength);
  const calcRangeEmpty = calcStart !== null && calcEnd !== null && calcStart >= calcEnd;

  // Get algorithm info for UI hints
  const selectedAlgorithm = CHECKSUM_ALGORITHMS.find((a) => a.id === fields.algorithm);
  const expectedOutputBytes = selectedAlgorithm?.outputBytes ?? 1;

  return (
    <Dialog isOpen={open} onClose={onCancel} size="xl" title={t(editingIndex !== null ? "checksumDialog.editTitle" : "checksumDialog.addTitle")}>
      <DialogBody className="space-y-4">
        <FormField label={t("checksumDialog.name")} required variant="default">
          <Input
            size="lg"
            value={fields.name}
            onChange={(e) => setFields({ ...fields, name: e.target.value })}
            placeholder={t("checksumDialog.namePlaceholder")}
          />
        </FormField>

        <div>
          <FormField label={t("checksumDialog.algorithm")} required variant="default">
            <Select
              size="lg"
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
                  {t("checksumDialog.algorithmOption", { name: algo.name, count: algo.outputBytes })}
                </option>
              ))}
            </Select>
          </FormField>
          {selectedAlgorithm && (
            <p className={`mt-1 ${helpText}`}>{selectedAlgorithm.description}</p>
          )}
        </div>

        <Card tone="purple" padding="lg">
          <h3 className={`${h3} text-purple mb-3`}>{t("checksumDialog.location")}</h3>
          <p className="text-xs text-purple mb-3">{t("checksumDialog.locationHint")}</p>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <FormField label={t("checksumDialog.startByte")} required variant="default">
                <Input
                  size="lg"
                  type="number"
                  min={-frameLength}
                  max={frameLength - 1}
                  value={fields.start_byte}
                  onChange={(e) => setFields({ ...fields, start_byte: Number(e.target.value) })}
                />
              </FormField>
              {fields.start_byte < 0 && (
                <p className="mt-1 text-xs text-purple">
                  {t("checksumDialog.resolvedByte", { index: checksumStart ?? "…" })}
                </p>
              )}
            </div>
            <div>
              <FormField label={t("checksumDialog.byteLength")} required variant="default">
                <Input
                  size="lg"
                  type="number"
                  min={1}
                  max={4}
                  value={fields.byte_length}
                  onChange={(e) => setFields({ ...fields, byte_length: Number(e.target.value) || 1 })}
                />
              </FormField>
              {fields.byte_length !== expectedOutputBytes && (
                <p className="mt-1 text-xs text-amber">
                  {t("checksumDialog.algorithmOutput", { count: expectedOutputBytes })}
                </p>
              )}
            </div>
            <FormField label={t("checksumDialog.endianness")} variant="default">
              <Select
                size="lg"
                value={fields.endianness || "big"}
                onChange={(e) =>
                  setFields({ ...fields, endianness: e.target.value as "little" | "big" })
                }
                disabled={fields.byte_length === 1}
              >
                <option value="big">{t("shared.bigEndian")}</option>
                <option value="little">{t("shared.littleEndian")}</option>
              </Select>
            </FormField>
          </div>
        </Card>

        <Card tone="info" padding="lg">
          <h3 className={`${h3} text-info mb-3`}>{t("checksumDialog.range")}</h3>
          <p className="text-xs text-info mb-3">{t("checksumDialog.rangeHint")}</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FormField label={t("checksumDialog.startByte")} required variant="default">
                <Input
                  size="lg"
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
                <p className="mt-1 text-xs text-blue">
                  {t("checksumDialog.resolvedByte", { index: calcStart ?? "…" })}
                </p>
              )}
            </div>
            <div>
              <FormField label={t("checksumDialog.endByte")} required variant="default">
                <Input
                  size="lg"
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
                <p className="mt-1 text-xs text-blue">
                  {t("checksumDialog.resolvedByte", { index: calcEnd ?? "…" })}
                </p>
              )}
            </div>
          </div>
          {calcStart !== null && calcEnd !== null && (calcRangeEmpty ? (
            <p className="mt-2 text-xs text-red">
              {t("checksumDialog.rangeEmpty", { start: calcStart, end: calcEnd })}
            </p>
          ) : (
            <p className={`mt-2 ${helpText}`}>
              {t("checksumDialog.rangeSummary", { start: calcStart, last: calcEnd - 1, count: calcEnd - calcStart })}
            </p>
          ))}
        </Card>

        <div className="p-4 bg-surface rounded-lg">
          <h3 className={`${h3} mb-3`}>{t("checksumDialog.layoutPreview")}</h3>
          <div className="flex flex-wrap gap-1 font-mono text-xs">
            {Array.from({ length: frameLength }).map((_, i) => {
              const isChecksumByte =
                checksumStart !== null && i >= checksumStart && i < checksumStart + fields.byte_length;
              const isCalcByte = calcStart !== null && calcEnd !== null && i >= calcStart && i < calcEnd;

              let bgClass = "bg-tertiary text-muted";
              if (isChecksumByte) {
                bgClass = "bg-purple text-purple";
              } else if (isCalcByte) {
                bgClass = "bg-info text-info";
              }

              return (
                <div
                  key={i}
                  className={`w-7 h-7 flex items-center justify-center rounded ${bgClass}`}
                  title={
                    isChecksumByte
                      ? t("checksumDialog.byteIsChecksum")
                      : isCalcByte
                        ? t("checksumDialog.byteInRange")
                        : t("checksumDialog.byte", { index: i })
                  }
                >
                  {i}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-4 mt-2 text-xs text-muted">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-purple"></div>
              <span>{t("checksumDialog.legendChecksum")}</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-info"></div>
              <span>{t("checksumDialog.legendRange")}</span>
            </div>
          </div>
        </div>

        <FormField label={t("shared.notes")} variant="default">
          <Textarea
            size="lg"
            value={fields.notes || ""}
            onChange={(e) => setFields({ ...fields, notes: e.target.value || undefined })}
            placeholder={t("shared.notesPlaceholderChecksum")}
            rows={2}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onCancel}>{t("common:actions.cancel")}</SecondaryButton>
        <PrimaryButton
          onClick={onSave}
          disabled={
            !fields.name.trim() ||
            !fields.algorithm ||
            calcStart === null ||
            calcEnd === null ||
            calcRangeEmpty
          }
        >
          {t(editingIndex !== null ? "checksumDialog.update" : "checksumDialog.addTitle")}
        </PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
