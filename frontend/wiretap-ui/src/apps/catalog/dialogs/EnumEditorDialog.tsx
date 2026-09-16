// ui/src/apps/catalog/dialogs/EnumEditorDialog.tsx

import { useState, useEffect } from "react";
import { Plus, Trash2 } from "lucide-react";
import { iconMd } from "../../../styles/spacing";
import Dialog from "../../../components/Dialog";
import { Input, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { h2, helpText, alertDanger, labelSmall } from "../../../styles";
import { parseIntValue, isValidIntValue } from "../../../utils/numberUtils";

export type EnumValue = {
  rawValue: string;
  label: string;
};

export type EnumEditorDialogProps = {
  open: boolean;
  enumValues: Record<string, string>;
  onSave: (values: Record<string, string>) => void;
  onCancel: () => void;
};

function recordToArray(record: Record<string, string>): EnumValue[] {
  return Object.entries(record).map(([rawValue, label]) => ({ rawValue, label }));
}

function arrayToRecord(arr: EnumValue[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const { rawValue, label } of arr) {
    if (rawValue.trim() !== "") {
      // Convert hex values to decimal integers for storage
      const numValue = parseIntValue(rawValue);
      result[numValue.toString()] = label;
    }
  }
  return result;
}

export default function EnumEditorDialog({
  open,
  enumValues,
  onSave,
  onCancel,
}: EnumEditorDialogProps) {
  const [values, setValues] = useState<EnumValue[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      const arr = recordToArray(enumValues);
      // Sort by numeric key
      arr.sort((a, b) => {
        const numA = parseInt(a.rawValue, 10);
        const numB = parseInt(b.rawValue, 10);
        if (isNaN(numA) && isNaN(numB)) return 0;
        if (isNaN(numA)) return 1;
        if (isNaN(numB)) return -1;
        return numA - numB;
      });
      setValues(arr.length > 0 ? arr : [{ rawValue: "", label: "" }]);
      setError(null);
    }
  }, [open, enumValues]);

  const handleAdd = () => {
    setValues([...values, { rawValue: "", label: "" }]);
  };

  const handleRemove = (index: number) => {
    setValues(values.filter((_, i) => i !== index));
  };

  const handleChange = (index: number, field: "rawValue" | "label", value: string) => {
    const updated = [...values];
    updated[index] = { ...updated[index], [field]: value };
    setValues(updated);
    setError(null);
  };

  const validate = (): boolean => {
    // Filter out empty rows
    const nonEmpty = values.filter((v) => v.rawValue.trim() !== "" || v.label.trim() !== "");

    // Check for valid integer raw values (decimal or hex)
    for (const v of nonEmpty) {
      const trimmed = v.rawValue.trim();
      if (trimmed === "") {
        setError("Raw value cannot be empty");
        return false;
      }
      if (!isValidIntValue(trimmed)) {
        setError(`Invalid raw value: "${trimmed}" (must be an integer or hex like 0x1F)`);
        return false;
      }
      if (v.label.trim() === "") {
        const num = parseIntValue(trimmed);
        setError(`Label for value ${num} cannot be empty`);
        return false;
      }
    }

    // Check for duplicates (comparing as integers to catch 0x10 == 16)
    const seen = new Map<number, string>();
    for (const v of nonEmpty) {
      const num = parseIntValue(v.rawValue);
      if (seen.has(num)) {
        setError(`Duplicate raw value: ${v.rawValue.trim()} (same as ${seen.get(num)})`);
        return false;
      }
      seen.set(num, v.rawValue.trim());
    }

    return true;
  };

  const handleSave = () => {
    if (!validate()) return;

    // Filter out empty rows and convert to record
    const nonEmpty = values.filter((v) => v.rawValue.trim() !== "" && v.label.trim() !== "");
    onSave(arrayToRecord(nonEmpty));
  };

  if (!open) return null;

  return (
    <Dialog isOpen={open} maxWidth="max-w-lg" onBackdropClick={onCancel}>
      <div className="p-6">
        <h2 className={`${h2} mb-4`}>Edit Enum Values</h2>
        <p className={`${helpText} mb-4`}>
          Map raw signal values to human-readable labels.
        </p>

        <div className="space-y-2 max-h-80 overflow-y-auto">
          <div className={`grid grid-cols-[1fr_2fr_auto] gap-2 ${labelSmall} px-1`}>
            <span>Raw Value</span>
            <span>Label</span>
            <span className="w-8"></span>
          </div>

          {values.map((v, i) => (
            <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2 items-center">
              <Input
                variant="default"
                type="text"
                value={v.rawValue}
                onChange={(e) => handleChange(i, "rawValue", e.target.value)}
                placeholder="0 or 0x1F"
              />
              <Input
                variant="default"
                type="text"
                value={v.label}
                onChange={(e) => handleChange(i, "label", e.target.value)}
                placeholder="Label"
              />
              <button
                type="button"
                onClick={() => handleRemove(i)}
                className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                title="Remove"
              >
                <Trash2 className={iconMd} />
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={handleAdd}
          className="mt-3 flex items-center gap-2 px-3 py-2 text-sm text-[color:var(--accent-primary)] hover:bg-[var(--accent-bg-subtle)] rounded-lg transition-colors"
        >
          <Plus className={iconMd} />
          Add Value
        </button>

        {error && (
          <div className={`mt-4 ${alertDanger}`}>{error}</div>
        )}

        <div className="flex justify-end gap-3 mt-6">
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <PrimaryButton onClick={handleSave}>Save</PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
