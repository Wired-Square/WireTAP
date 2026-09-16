// Copyright 2026 Wired Square Pty Ltd

/**
 * The Decoder's Modbus tab: Modbus RTU exchanges, newest first — tunnelled
 * inside a CAN id, or read off a serial port.
 *
 * A tunnel frame's payload is a slice of a byte stream, so a single CAN frame
 * row tells you nothing — the request and its reply share one id and a reply
 * often spans two or three frames. This view shows what the reassembler
 * actually recovered: one row per complete message, paired request to response,
 * with the round-trip time and the bytes it was rebuilt from. A row whose CRC
 * did not match is badged rather than hidden, which is only possible with
 * "Require valid CRC-16" unticked.
 *
 * The signals themselves land in the Signals tab like any other frame; this is
 * the protocol-level trace beside them.
 */

import { memo } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, ArrowLeft } from "lucide-react";
import {
  bgDataView,
  emptyStateContainer,
  emptyStateText,
  textMuted,
  textDataPrimary,
  textDataPurple,
  textDataCyan,
  textDataAmber,
  textDataGreen,
  textDanger,
  textWarning,
} from "../../../styles";
import { iconXs } from "../../../styles/spacing";
import { formatHumanUs, formatDeltaUs } from "../../../utils/timeFormat";
import { formatFrameId } from "../../../utils/frameIds";
import { byteToHex, u16ToHex } from "../../../utils/byteUtils";
import type { TunnelTransaction } from "../../../stores/decoderStore";
import type { FrameIdFormat } from "../../../types/common";

interface DecoderTunnelViewProps {
  transactions: TunnelTransaction[];
  displayFrameIdFormat: FrameIdFormat;
}

/** Register values as `0xNNNN`, each at the register it sits in. */
function registerList(t: TunnelTransaction): string {
  return t.values
    .map((v, i) =>
      t.register == null ? u16ToHex(v) : `[${t.register + i}] ${u16ToHex(v)}`,
    )
    .join("  ");
}

const TransactionRow = memo(function TransactionRow({
  t,
  displayFrameIdFormat,
  translate,
}: {
  t: TunnelTransaction;
  displayFrameIdFormat: FrameIdFormat;
  translate: (key: string, options?: Record<string, unknown>) => string;
}) {
  const isRequest = t.direction === "request";
  const Arrow = isRequest ? ArrowRight : ArrowLeft;

  return (
    <div className={`flex flex-col gap-1 px-3 py-1.5 ${bgDataView} rounded text-sm font-mono`}>
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`${textMuted} text-xs`}>{formatHumanUs(t.timestampUs)}</span>
        <span className={`${textDataPurple} font-semibold`}>
          {formatFrameId(t.frameId, displayFrameIdFormat, t.frameId > 0x7ff)}
        </span>
        <Arrow className={`${iconXs} ${isRequest ? textDataCyan : textDataGreen}`} />
        <span className={isRequest ? textDataCyan : textDataGreen}>
          {translate(`tunnelView.${t.direction}`)}
        </span>
        <span className={`${textMuted} text-xs`}>
          {translate("tunnelView.unit", { device: t.device })}
        </span>
        <span className={textDataPrimary}>{t.functionLabel}</span>
        {t.register != null && (
          <span className={textDataAmber}>@{u16ToHex(t.register)}</span>
        )}
        {t.quantity != null && (
          <span className={`${textMuted} text-xs`}>×{t.quantity}</span>
        )}
        {t.latencyUs != null && (
          <span className={`${textMuted} text-xs`}>{formatDeltaUs(t.latencyUs)}</span>
        )}
        {t.frames > 1 && (
          <span className={`${textMuted} text-xs`}>
            {translate("tunnelView.frameSpan", { count: t.frames })}
          </span>
        )}
        {t.frame && <span className={`${textDataCyan} text-xs`}>{t.frame}</span>}
        {/* Only reachable with "Require valid CRC-16" unticked; under the
            default policy a message that failed its CRC is not a message. */}
        {!t.crcValid && (
          <span
            className={`${textWarning} text-xs`}
            title={translate("tunnelView.crcInvalidHint")}
          >
            {translate("tunnelView.crcInvalid")}
          </span>
        )}
      </div>
      {t.exceptionLabel && (
        <div className={`${textDanger} text-xs`}>{t.exceptionLabel}</div>
      )}
      {t.values.length > 0 ? (
        <div className={`${textDataPrimary} text-xs`}>{registerList(t)}</div>
      ) : (
        // A coil bank and a vendor code both carry a body with no registers to
        // name, and for a vendor code this is the only view of its payload.
        t.data.length > 0 && (
          <div className={`${textDataPrimary} text-xs break-all`}>
            {t.data.map(byteToHex).join(" ")}
          </div>
        )
      )}
      {/* The reassembled message, CRC included. */}
      <div className={`${textMuted} text-xs break-all`}>
        {t.raw.map(byteToHex).join(" ")}
      </div>
    </div>
  );
});

export default function DecoderTunnelView({
  transactions,
  displayFrameIdFormat,
}: DecoderTunnelViewProps) {
  const { t } = useTranslation("decoder");

  if (transactions.length === 0) {
    return (
      <div className={emptyStateContainer}>
        <p className={emptyStateText}>{t("tunnelView.empty")}</p>
      </div>
    );
  }

  // The store mutates its buffer in place, so this cannot be memoised on the
  // array's identity — it never changes. `decodedVersion` re-renders us instead.
  return (
    <div className="space-y-1">
      {transactions
        .slice()
        .reverse()
        .map((tx, i) => (
          <TransactionRow
            key={`${tx.timestampUs}-${tx.frameId}-${i}`}
            t={tx}
            displayFrameIdFormat={displayFrameIdFormat}
            translate={t}
          />
        ))}
    </div>
  );
}
