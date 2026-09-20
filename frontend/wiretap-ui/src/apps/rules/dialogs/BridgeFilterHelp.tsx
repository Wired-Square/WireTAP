// Copyright 2026 Wired Square Pty Ltd

import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { labelDefault } from "../../../styles/typography";
import { textPrimary, textSecondary } from "../../../styles";
import {
  BIT_WIDTH_STD,
  BIT_WIDTH_EXT,
  ID_MASK_11,
  ID_MASK_29,
  isValidHex,
  parseHex,
  matchedIdCount,
  matchedRange,
} from "../utils/canMask";
import { formatHexId } from "../utils/formatHex";
import MaskBitRow from "../components/MaskBitRow";
import type { BridgeFilterKind, BridgeFilterIde } from "../../../api/framelinkRules";
import { Button } from "../../../components/Button";
import { Input } from "../../../components/forms";

interface BridgeFilterHelpProps {
  kind: BridgeFilterKind;
  ide: BridgeFilterIde;
  onApplyMask: (canIdHex: string, maskHex: string) => void;
}

const DEFAULT_CALC_ID = "100";
const DEFAULT_CALC_MASK = "700";

function bitWidthForIde(ide: BridgeFilterIde): number {
  return ide === "ext" ? BIT_WIDTH_EXT : BIT_WIDTH_STD;
}

function widthMaskForIde(ide: BridgeFilterIde): number {
  return ide === "ext" ? ID_MASK_29 : ID_MASK_11;
}

function hexBytesForIde(ide: BridgeFilterIde): number {
  return ide === "ext" ? 4 : 2;
}

export default function BridgeFilterHelp({ kind, ide, onApplyMask }: BridgeFilterHelpProps) {
  const { t } = useTranslation("rules");
  const [calcId, setCalcId] = useState(DEFAULT_CALC_ID);
  const [calcMask, setCalcMask] = useState(DEFAULT_CALC_MASK);

  const bitWidth = bitWidthForIde(ide);
  const widthMask = widthMaskForIde(ide);
  const hexBytes = hexBytesForIde(ide);

  const idValid = isValidHex(calcId);
  const maskValid = isValidHex(calcMask);
  const calcInputValid = idValid && maskValid;

  const idValue = parseHex(calcId, 0, widthMask);
  const maskValue = parseHex(calcMask, 0, widthMask);

  const summary = useMemo(() => {
    if (!calcInputValid) return null;
    const count = matchedIdCount(maskValue, bitWidth);
    const { lo, hi } = matchedRange(idValue, maskValue, bitWidth);
    if (count === 1) {
      return t("bridgeDialog.help.maskMatchedSingle", { id: formatHexId(lo, hexBytes) });
    }
    return t("bridgeDialog.help.maskMatchedRange", {
      count,
      lo: formatHexId(lo, hexBytes),
      hi: formatHexId(hi, hexBytes),
    });
  }, [calcInputValid, idValue, maskValue, bitWidth, hexBytes, t]);

  if (kind === "range") {
    return (
      <div className="mt-2 p-3 rounded bg-white/5 border border-default">
        <p className={`text-xs ${textSecondary} mb-2`}>{t("bridgeDialog.help.rangeIntro")}</p>
        <p className={`text-xs ${textSecondary}`}>{t("bridgeDialog.help.rangeExample")}</p>
      </div>
    );
  }

  return (
    <div className="mt-2 p-3 rounded bg-white/5 border border-default space-y-3">
      <p className={`text-xs ${textSecondary}`}>{t("bridgeDialog.help.maskIntro")}</p>

      <div>
        <div className={`text-xs font-semibold ${textPrimary} mb-2`}>
          {t("bridgeDialog.help.maskTryIt")}
        </div>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className={labelDefault}>{t("bridgeDialog.help.maskCalcCanId")}</label>
            <Input
              type="text"
              size="lg"
              mono
              aria-invalid={!idValid}
              value={calcId}
              onChange={(e) => setCalcId(e.target.value)}
              placeholder={t("bridgeDialog.fields.canIdHex")}
            />
          </div>
          <div>
            <label className={labelDefault}>{t("bridgeDialog.help.maskCalcMask")}</label>
            <Input
              type="text"
              size="lg"
              mono
              aria-invalid={!maskValid}
              value={calcMask}
              onChange={(e) => setCalcMask(e.target.value)}
              placeholder={t("bridgeDialog.fields.maskHex")}
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <MaskBitRow
            label={`ID ${formatHexId(idValue, hexBytes)}`}
            value={idValue}
            mask={maskValue}
            bitWidth={bitWidth}
            dimWhenMaskZero
            showHeader
          />
          <MaskBitRow
            label={`Mask ${formatHexId(maskValue, hexBytes)}`}
            value={maskValue}
            bitWidth={bitWidth}
          />
        </div>

        {summary && <p className={`text-xs ${textPrimary} mt-2`}>{summary}</p>}

        <div className="mt-3 flex justify-end">
          <Button
            onClick={() => onApplyMask(calcId, calcMask)}
            disabled={!calcInputValid}
            variant="solid"
            tone="primary"
            size="sm"
          >
            {t("bridgeDialog.fields.useTheseValues")}
          </Button>
        </div>
      </div>
    </div>
  );
}
