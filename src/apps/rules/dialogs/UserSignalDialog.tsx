// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";
import Dialog from "../../../components/Dialog";
import { inputSimple, labelDefault } from "../../../styles/inputStyles";
import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { panelFooter } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import { RESERVED_SIGNAL_ID_START } from "../utils/framelinkConstants";

// ============================================================================
// Constants
// ============================================================================

/** User signals must use IDs below the reserved range */
const MAX_USER_SIGNAL_ID = RESERVED_SIGNAL_ID_START - 1;

const FORMAT_OPTIONS = [
  { value: "number", label: "Number" },
  { value: "bool", label: "Boolean" },
  { value: "enum", label: "Enum" },
  { value: "color_brgb", label: "Colour (BRGB)" },
  { value: "temperature_0.1", label: "Temperature (0.1\u00B0)" },
] as const;

const DEFAULT_GROUP = "User";

// ============================================================================
// Types
// ============================================================================

export interface UserSignalMetadata {
  name: string;
  group: string;
  format: string;
  unit: string;
  enum_values?: Record<string, string>;
}

interface UserSignalDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (signalId: number, metadata: UserSignalMetadata) => void;
  /** Set of signal IDs already in use (across all tiers) */
  usedSignalIds: Set<number>;
}

interface EnumRow {
  value: string;
  label: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Validate a hex string as a valid signal ID (0x0000–0xFFFF). */
function parseHexSignalId(hex: string): number | null {
  const trimmed = hex.trim().replace(/^0x/i, "");
  if (trimmed.length === 0 || !/^[0-9a-fA-F]+$/.test(trimmed)) return null;
  const value = parseInt(trimmed, 16);
  if (isNaN(value) || value < 0 || value > MAX_USER_SIGNAL_ID) return null;
  return value;
}

/** Find the lowest unused signal ID starting from 1. */
function nextAvailableId(usedIds: Set<number>): string {
  for (let id = 1; id <= MAX_USER_SIGNAL_ID; id++) {
    if (!usedIds.has(id)) {
      return id.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  return "";
}

// ============================================================================
// Component
// ============================================================================

export default function UserSignalDialog({
  isOpen,
  onClose,
  onAdd,
  usedSignalIds,
}: UserSignalDialogProps) {
  const [signalIdHex, setSignalIdHex] = useState(() => nextAvailableId(usedSignalIds));
  const [name, setName] = useState("");
  const [group, setGroup] = useState(DEFAULT_GROUP);
  const [format, setFormat] = useState("number");
  const [unit, setUnit] = useState("");
  const [enumRows, setEnumRows] = useState<EnumRow[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setSignalIdHex(nextAvailableId(usedSignalIds));
    setName("");
    setGroup(DEFAULT_GROUP);
    setFormat("number");
    setUnit("");
    setEnumRows([]);
    setValidationError(null);
  }, [usedSignalIds]);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const addEnumRow = useCallback(() => {
    setEnumRows((prev) => [...prev, { value: "0", label: "" }]);
  }, []);

  const removeEnumRow = useCallback((idx: number) => {
    setEnumRows((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updateEnumRow = useCallback(
    (idx: number, field: keyof EnumRow, value: string) => {
      setEnumRows((prev) =>
        prev.map((row, i) => (i === idx ? { ...row, [field]: value } : row)),
      );
    },
    [],
  );

  const handleSubmit = useCallback(() => {
    // Validate signal ID
    const parsedId = parseHexSignalId(signalIdHex);
    if (parsedId === null) {
      setValidationError("Signal ID must be a valid hex value (0x0001–0xFCFF). IDs 0xFD00+ are reserved.");
      return;
    }
    if (usedSignalIds.has(parsedId)) {
      setValidationError(`Signal ID 0x${parsedId.toString(16).toUpperCase().padStart(4, "0")} is already in use.`);
      return;
    }

    // Validate name
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name is required.");
      return;
    }

    // Build metadata
    const metadata: UserSignalMetadata = {
      name: trimmedName,
      group: group.trim() || DEFAULT_GROUP,
      format,
      unit: unit.trim(),
    };

    // Include enum values when format is "enum"
    if (format === "enum" && enumRows.length > 0) {
      const enumValues: Record<string, string> = {};
      for (const row of enumRows) {
        const numericKey = row.value.trim();
        const enumLabel = row.label.trim();
        if (numericKey.length > 0 && enumLabel.length > 0) {
          enumValues[numericKey] = enumLabel;
        }
      }
      if (Object.keys(enumValues).length > 0) {
        metadata.enum_values = enumValues;
      }
    }

    setValidationError(null);
    onAdd(parsedId, metadata);
    resetForm();
  }, [signalIdHex, name, group, format, unit, enumRows, onAdd, resetForm]);

  return (
    <Dialog isOpen={isOpen} onBackdropClick={handleClose} maxWidth="max-w-lg">
      <div className="p-6">
        <h2 className={`text-lg font-semibold ${textPrimary} mb-4`}>
          Add User Signal
        </h2>

        <div className="space-y-4">
          {/* Signal ID */}
          <div>
            <label className={labelDefault}>Signal ID (hex)</label>
            <input
              type="text"
              className={`${inputSimple} font-mono`}
              value={signalIdHex}
              onChange={(e) => setSignalIdHex(e.target.value)}
              placeholder="e.g. A001"
            />
          </div>

          {/* Name */}
          <div>
            <label className={labelDefault}>Name</label>
            <input
              type="text"
              className={inputSimple}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cabin Temperature"
            />
          </div>

          {/* Group + Format side by side */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelDefault}>Group</label>
              <input
                type="text"
                className={inputSimple}
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder={DEFAULT_GROUP}
              />
            </div>
            <div>
              <label className={labelDefault}>Format</label>
              <select
                className={inputSimple}
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                {FORMAT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Unit */}
          <div>
            <label className={labelDefault}>Unit (optional)</label>
            <input
              type="text"
              className={inputSimple}
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="e.g. °C, V, rpm"
            />
          </div>

          {/* Enum values — shown only when format is "enum" */}
          {format === "enum" && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className={labelDefault}>Enum Values</label>
                <button
                  onClick={addEnumRow}
                  className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                >
                  <Plus className={iconMd} /> Add Value
                </button>
              </div>

              {enumRows.length > 0 && (
                <div className="space-y-2">
                  {enumRows.map((row, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        type="text"
                        className={`${inputSimple} font-mono w-20 shrink-0`}
                        value={row.value}
                        onChange={(e) =>
                          updateEnumRow(idx, "value", e.target.value)
                        }
                        placeholder="Value"
                      />
                      <input
                        type="text"
                        className={`${inputSimple} flex-1`}
                        value={row.label}
                        onChange={(e) =>
                          updateEnumRow(idx, "label", e.target.value)
                        }
                        placeholder="Label"
                      />
                      <button
                        onClick={() => removeEnumRow(idx)}
                        className={`p-1 rounded hover:bg-red-500/20 ${textTertiary} hover:text-red-400`}
                      >
                        <Trash2 className={iconMd} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {enumRows.length === 0 && (
                <p className={`text-xs ${textSecondary}`}>
                  No enum values defined. Click "Add Value" to define mappings.
                </p>
              )}
            </div>
          )}

          {/* Validation error */}
          {validationError && (
            <p className="text-xs text-red-400">{validationError}</p>
          )}
        </div>
      </div>

      <div className={`${panelFooter} flex justify-end gap-2`}>
        <button
          onClick={handleClose}
          className={`px-4 py-2 text-sm rounded ${textSecondary} hover:bg-white/10`}
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          className="px-4 py-2 text-sm font-medium rounded bg-indigo-600 hover:bg-indigo-500 text-white"
        >
          Add Signal
        </button>
      </div>
    </Dialog>
  );
}
