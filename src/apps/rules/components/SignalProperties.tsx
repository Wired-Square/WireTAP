// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("rules");
  if (signal === null) {
    return (
      <div className={`flex items-center justify-center h-full text-center px-4 text-sm ${textTertiary}`}>
        {t("signalProperties.emptyHint")}
      </div>
    );
  }

  const isNameEmpty = signal.name.trim().length === 0;

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Name */}
      <div>
        <label className={labelDefault}>{t("signalProperties.name")}</label>
        <input
          type="text"
          className={inputSimple}
          value={signal.name}
          onChange={(e) => onChange("name", e.target.value)}
          placeholder={t("signalProperties.namePlaceholder")}
          autoFocus={isNameEmpty}
        />
        {isNameEmpty && (
          <p className={`text-xs mt-1 ${textDanger}`}>{t("signalProperties.nameRequired")}</p>
        )}
      </div>

      {/* Start Bit / Length — read-only */}
      <div>
        <label className={labelDefault}>{t("signalProperties.position")}</label>
        <p className={`text-sm ${textSecondary}`}>
          {t("signalProperties.positionFmt", { startBit: signal.startBit, count: signal.bitLength })}
        </p>
      </div>

      {/* Byte Order */}
      <div>
        <label className={labelDefault}>{t("signalProperties.byteOrder")}</label>
        <select
          className={inputSimple}
          value={signal.byteOrder}
          onChange={(e) => onChange("byteOrder", parseInt(e.target.value))}
        >
          <option value={BYTE_ORDER_LE}>{t("signalProperties.littleEndian")}</option>
          <option value={BYTE_ORDER_BE}>{t("signalProperties.bigEndian")}</option>
        </select>
      </div>

      {/* Value Type */}
      <div>
        <label className={labelDefault}>{t("signalProperties.valueType")}</label>
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
        <label className={labelDefault}>{t("signalProperties.scale")}</label>
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
        <label className={labelDefault}>{t("signalProperties.offset")}</label>
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
        {t("signalProperties.delete")}
      </button>
    </div>
  );
}
