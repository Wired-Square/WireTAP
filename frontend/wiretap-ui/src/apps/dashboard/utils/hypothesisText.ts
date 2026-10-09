// ui/src/apps/dashboard/utils/hypothesisText.ts

import type { TFunction } from "i18next";
import type { CandidateReason } from "../../../api/adhoc";
import type { HypothesisParams } from "../../../stores/dashboardStore";

export function reasonText(t: TFunction, reasons: CandidateReason[]): string {
  const text = reasons.map((r) => {
    switch (r.code) {
      case "role": return t("hypothesis.reasons.role", { role: t(`hypothesis.reasons.roles.${r.role}`) });
      case "pattern": return t(`hypothesis.reasons.pattern.${r.exact ? "exact" : "overlap"}.${r.kind}`);
      default: return t(`hypothesis.reasons.${r.code}`);
    }
  });
  return text.length > 0 ? text.join(", ") : t("hypothesis.reasons.none");
}

export function candidateLabel({ startBit, bitLength, endianness, signed }: HypothesisParams): string {
  const position = startBit % 8 === 0 ? `byte ${startBit / 8}` : `bit ${startBit}`;
  const order = bitLength > 8 ? (endianness === "little" ? " LE" : " BE") : "";
  return `${position}, ${bitLength}-bit${order}${signed ? " signed" : ""}`;
}
