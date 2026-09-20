// ui/src/apps/discovery/views/tools/ModbusFcProbeResultView.tsx
//
// Which function codes a device answers — the cheapest first question to ask an
// unknown Modbus device, and the one that decides what a sweep should look for.
//
// The distinction the table draws is the whole point. A Modbus **exception**
// proves the function code is implemented and the address was simply wrong;
// **silence** carries no information at all and usually means the code is not
// implemented. Those want different next moves, so they are never one colour.

import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { ModbusFcProbeResults } from "../../../../stores/discoveryToolboxStore";
import {
  bgDataView,
  borderDefault,
  textDataAmber,
  textDataGreen,
  textMuted,
  textPrimary,
  textSecondary,
} from "../../../../styles";
import { Table } from "../../../../components/Table";
import { iconSm } from "../../../../styles/spacing";
import type { FcVerdict } from "../../../../api/io";
import { IconButton } from "../../../../components/Button";

type Props = {
  results: ModbusFcProbeResults;
  onClose: () => void;
};

/** Verdict → a short label plus the colour that carries the meaning. */
function verdictLabel(v: FcVerdict, t: (k: string) => string): { text: string; className: string } {
  switch (v.verdict) {
    case "values":
      return {
        text: v.values.length > 0
          ? `0x${v.values[0].toString(16).padStart(4, "0").toUpperCase()}`
          : t("modbusFc.ok"),
        className: textDataGreen,
      };
    case "bits":
      return { text: v.values[0] ? "1" : "0", className: textDataGreen };
    case "exception":
      return { text: t("modbusFc.exception"), className: textDataAmber };
    case "silent":
      return { text: t("modbusFc.silent"), className: textMuted };
  }
}


export default function ModbusFcProbeResultView({ results, onClose }: Props) {
  const { t } = useTranslation("discovery");
  const { isProbing, deviceName, entries, error } = results;

  // Keyed to just the four verdict fields, so the cells need no cast.
  const columns: Array<{ key: "holding" | "input" | "coil" | "discrete"; label: string }> = [
    { key: "holding", label: t("modbusFc.holding") },
    { key: "input", label: t("modbusFc.input") },
    { key: "coil", label: t("modbusFc.coil") },
    { key: "discrete", label: t("modbusFc.discrete") },
  ];

  return (
    <div className={`flex flex-col h-full ${bgDataView}`}>
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${borderDefault}`}>
        <div className="flex items-center gap-3">
          <h3 className={`text-sm font-medium ${textPrimary}`}>{t("modbusFc.title")}</h3>
          <span className={`text-xs ${textMuted}`}>
            {isProbing ? t("modbusFc.probingDevice", { device: deviceName }) : deviceName}
          </span>
        </div>
        {!isProbing && (
          <IconButton onClick={onClose} size="sm" title={t("modbusFc.close")}>
            <X className={iconSm} />
          </IconButton>
        )}
      </div>

      {isProbing && (
        <div className="h-1 bg-surface">
          <div className="h-full w-1/3 bg-text-purple animate-pulse" />
        </div>
      )}

      <div className={`flex-1 overflow-auto ${bgDataView}`}>
        {error ? (
          <p className="px-4 py-3 text-xs text-danger">{error}</p>
        ) : (
          <Table mono sticky>
            <thead>
              <tr>
                <th>{t("modbusFc.unit")}</th>
                {columns.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((r) => (
                <tr key={r.unit_id}>
                  <td>{r.unit_id}</td>
                  {columns.map((c) => {
                    const { text, className } = verdictLabel(r[c.key], t);
                    return (
                      <td key={c.key} className={className}>
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
        )}

        {!isProbing && !error && entries.length > 0 && (
          <p className={`px-4 py-2 text-xs ${textSecondary}`}>
            {entries.some((r) => r.responded)
              ? t("modbusFc.hintFound")
              : t("modbusFc.hintNothing")}
          </p>
        )}
      </div>
    </div>
  );
}
