import { useTranslation } from "react-i18next";
import type { FramingMode } from "../../../../generated/FramingMode";
import { Select } from "../../../../components/forms";
import { caption } from "../../../../styles";

const ENCODINGS = Object.keys({ slip: 1, raw: 1, delimiter: 1, modbus_rtu: 1 } satisfies Record<FramingMode, 1>) as FramingMode[];

export default function SerialEncodingSelect({ value, onChange }: { value: FramingMode | null; onChange: (encoding: FramingMode) => void }) {
  const { t } = useTranslation("catalog");
  return (
    <>
      <Select size="lg" value={value ?? ""} onChange={(e) => onChange(e.target.value as FramingMode)}>
        {value === null && <option value="" disabled>{t("serialConfig.encodingUnknown")}</option>}
        {ENCODINGS.map((encoding) => (
          <option key={encoding} value={encoding}>{t(`serialConfig.encodings.${encoding}`)}</option>
        ))}
      </Select>
      <p className={`mt-1 ${caption}`}>
        {value === null ? t("serialConfig.encodingUnknownHint") : t(`serialConfig.encodingHints.${value}`)}
      </p>
    </>
  );
}
