// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { textSecondary, textTertiary, textDanger } from "../../../styles";
import { inputSimple, labelDefault } from "../../../styles/inputStyles";
import { type PlacedSignal, VALUE_TYPES, BYTE_ORDER_LE, BYTE_ORDER_BE } from "../utils/bitGrid";

interface SignalPropertiesProps {
  signal: PlacedSignal | null;
  onChange: (field: keyof PlacedSignal, value: string | number) => void;
  onDelete: () => void;
  validationError: string | null;
}

export default function SignalProperties({
  signal,
  onChange,
  onDelete,
  validationError,
}: SignalPropertiesProps) {
  if (signal === null) {
    return (
      <div className={`flex items-center justify-center h-full text-center px-4 text-sm ${textTertiary}`}>
        Click two bits in the grid to define a signal range, or click a byte label to select a whole byte.
      </div>
    );
  }

  const isNameEmpty = signal.name.trim().length === 0;

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Name */}
      <div>
        <label className={labelDefault}>Name</label>
        <input
          type="text"
          className={inputSimple}
          value={signal.name}
          onChange={(e) => onChange("name", e.target.value)}
          placeholder="Signal name"
          autoFocus={isNameEmpty}
        />
        {isNameEmpty && (
          <p className={`text-xs mt-1 ${textDanger}`}>Signal name required</p>
        )}
      </div>

      {/* Start Bit / Length — read-only */}
      <div>
        <label className={labelDefault}>Position</label>
        <p className={`text-sm ${textSecondary}`}>
          Bit {signal.startBit}, {signal.bitLength} bit{signal.bitLength !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Byte Order */}
      <div>
        <label className={labelDefault}>Byte Order</label>
        <select
          className={inputSimple}
          value={signal.byteOrder}
          onChange={(e) => onChange("byteOrder", parseInt(e.target.value))}
        >
          <option value={BYTE_ORDER_LE}>Little Endian</option>
          <option value={BYTE_ORDER_BE}>Big Endian</option>
        </select>
      </div>

      {/* Value Type */}
      <div>
        <label className={labelDefault}>Value Type</label>
        <select
          className={inputSimple}
          value={signal.valueType}
          onChange={(e) => onChange("valueType", parseInt(e.target.value))}
        >
          {VALUE_TYPES.map((vt) => (
            <option key={vt.value} value={vt.value}>
              {vt.label}
            </option>
          ))}
        </select>
        {validationError && (
          <p className={`text-xs mt-1 ${textDanger}`}>{validationError}</p>
        )}
      </div>

      {/* Scale */}
      <div>
        <label className={labelDefault}>Scale</label>
        <input
          type="number"
          step="0.1"
          className={inputSimple}
          value={signal.scale}
          onChange={(e) => onChange("scale", parseFloat(e.target.value))}
        />
      </div>

      {/* Offset */}
      <div>
        <label className={labelDefault}>Offset</label>
        <input
          type="number"
          step="0.1"
          className={inputSimple}
          value={signal.offset}
          onChange={(e) => onChange("offset", parseFloat(e.target.value))}
        />
      </div>

      {/* Delete */}
      <button
        onClick={onDelete}
        className={`mt-2 w-full py-2 text-sm rounded border border-[color:var(--status-danger-border)] ${textDanger} hover:bg-[var(--status-danger-bg)] transition-colors`}
      >
        Delete Signal
      </button>
    </div>
  );
}
