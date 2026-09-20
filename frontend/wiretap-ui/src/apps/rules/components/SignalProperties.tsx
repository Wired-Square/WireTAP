// Copyright 2026 Wired Square Pty Ltd

import { useTranslation } from "react-i18next";
import { textSecondary, textDanger } from "../../../styles";
import { labelDefault } from "../../../styles/typography";
import { Button } from "../../../components/Button";
import { type PlacedSignal, VALUE_TYPES, BYTE_ORDER_LE, BYTE_ORDER_BE } from "../utils/bitGrid";
import { Input, Select } from "../../../components/forms";

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
      <div className={`flex items-center justify-center h-full text-center px-4 text-sm ${textSecondary}`}>
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
        <Input
          type="text"
          size="lg"
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
        <Select
          size="lg"
          value={signal.byteOrder}
          onChange={(e) => onChange("byteOrder", parseInt(e.target.value))}
        >
          <option value={BYTE_ORDER_LE}>{t("signalProperties.littleEndian")}</option>
          <option value={BYTE_ORDER_BE}>{t("signalProperties.bigEndian")}</option>
        </Select>
      </div>

      {/* Value Type */}
      <div>
        <label className={labelDefault}>{t("signalProperties.valueType")}</label>
        <Select
          size="lg"
          value={signal.valueType}
          onChange={(e) => onChange("valueType", parseInt(e.target.value))}
        >
          {VALUE_TYPES.map((vt) => (
            <option key={vt.value} value={vt.value}>
              {vt.label}
            </option>
          ))}
        </Select>
        {validationError && (
          <p className={`text-xs mt-1 ${textDanger}`}>{validationError}</p>
        )}
      </div>

      {/* Scale */}
      <div>
        <label className={labelDefault}>{t("signalProperties.scale")}</label>
        <Input
          type="number"
          step="0.1"
          size="lg"
          value={signal.scale}
          onChange={(e) => onChange("scale", parseFloat(e.target.value))}
        />
      </div>

      {/* Offset */}
      <div>
        <label className={labelDefault}>{t("signalProperties.offset")}</label>
        <Input
          type="number"
          step="0.1"
          size="lg"
          value={signal.offset}
          onChange={(e) => onChange("offset", parseFloat(e.target.value))}
        />
      </div>

      {/* Delete */}
      <Button
        onClick={onDelete}
        variant="outline"
        tone="danger"
        size="lg"
        className="mt-2 w-full"
      >
        {t("signalProperties.delete")}
      </Button>
    </div>
  );
}
