// ui/src/apps/transmit/views/SerialTransmitView.tsx
//
// Serial bytes editor and single-shot transmit view.

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, RotateCcw, Send } from "lucide-react";
import { useTransmitStore } from "../../../stores/transmitStore";
import { useActiveSession } from "../../../stores/sessionStore";
import { ioTransmitSerial } from "../../../api/transmit";
import { applyFraming } from "../utils/slipFraming";
import {
  bgDataToolbar,
  borderDataView,
  textDataPrimary,
  bgDataInput,
  textDataSecondary,
  textDataTertiary,
  focusBorder,
} from "../../../styles/colourTokens";
import { buttonBase, toggleChipClass } from "../../../styles/buttonStyles";
import { flexRowGap2 } from "../../../styles/spacing";
import { emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription, emptyStateHint } from "../../../styles/typography";
import { byteToHex, hexToBytes } from "../../../utils/byteUtils";

export default function SerialTransmitView() {
  const { t } = useTranslation("transmit");
  // Store selectors
  const activeSession = useActiveSession();
  const serialEditor = useTransmitStore((s) => s.serialEditor);

  // Store actions
  const updateSerialEditor = useTransmitStore((s) => s.updateSerialEditor);
  const addSerialToQueue = useTransmitStore((s) => s.addSerialToQueue);
  const resetSerialEditor = useTransmitStore((s) => s.resetSerialEditor);
  const setActiveTab = useTransmitStore((s) => s.setActiveTab);

  // Local state for transmit
  const [isSending, setIsSending] = useState(false);

  // Get connection state and capabilities
  const isConnected = activeSession?.lifecycleState === "connected";
  const canTransmit = isConnected && activeSession?.capabilities?.traits.tx_bytes === true;

  // Parse hex input for preview
  const parsedBytes = useMemo(() => {
    const hex = serialEditor.hexInput.replace(/\s/g, "");
    try {
      return hexToBytes(hex);
    } catch {
      return [];
    }
  }, [serialEditor.hexInput]);

  // Build preview
  const preview = useMemo(() => {
    if (parsedBytes.length === 0) return null;

    const hexStr = parsedBytes.map(byteToHex).join(" ");
    const asciiStr = parsedBytes
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");

    return { hex: hexStr, ascii: asciiStr, length: parsedBytes.length };
  }, [parsedBytes]);

  // Handle hex input change
  const handleHexInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      // Allow hex chars and spaces
      const value = e.target.value.replace(/[^0-9a-fA-F\s]/g, "").toUpperCase();
      updateSerialEditor({ hexInput: value });
    },
    [updateSerialEditor]
  );

  // Handle framing mode change
  const handleFramingModeChange = useCallback(
    (mode: "raw" | "slip" | "delimiter") => {
      updateSerialEditor({ framingMode: mode });
    },
    [updateSerialEditor]
  );

  // Handle delimiter change
  const handleDelimiterChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const hex = e.target.value.replace(/[^0-9a-fA-F\s]/g, "").toUpperCase();
      try {
        const bytes = hexToBytes(hex.replace(/\s/g, ""));
        updateSerialEditor({ delimiter: bytes });
      } catch {
        // Invalid input, ignore
      }
    },
    [updateSerialEditor]
  );

  // Handle add to queue
  const handleAddToQueue = useCallback(() => {
    addSerialToQueue();
    setActiveTab("queue");
  }, [addSerialToQueue, setActiveTab]);

  // Handle reset
  const handleReset = useCallback(() => {
    resetSerialEditor();
  }, [resetSerialEditor]);

  // Handle send
  const handleSend = useCallback(async () => {
    if (!activeSession?.id || parsedBytes.length === 0) return;

    // Apply framing using centralised utility
    const bytesToSend = applyFraming(
      parsedBytes,
      serialEditor.framingMode,
      serialEditor.delimiter
    );

    setIsSending(true);
    try {
      await ioTransmitSerial(activeSession.id, bytesToSend);
    } catch (e) {
      console.error("Serial transmit failed:", e);
    } finally {
      setIsSending(false);
    }
  }, [activeSession, parsedBytes, serialEditor.framingMode, serialEditor.delimiter]);

  // If not connected
  if (!isConnected) {
    return (
      <div className={emptyStateContainer}>
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>{t("serialView.notConnectedHeading")}</p>
          <p className={emptyStateDescription}>
            {t("serialView.notConnectedDescription")}
          </p>
        </div>
      </div>
    );
  }

  // If profile doesn't support serial
  if (!canTransmit) {
    return (
      <div className={emptyStateContainer}>
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>{t("serialView.notSupportedHeading")}</p>
          <p className={emptyStateDescription}>
            {t("serialView.notSupportedDescription")}
          </p>
          <p className={emptyStateHint}>
            {t("serialView.notSupportedHint")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Hex Input */}
      <div className={`p-4 border-b ${borderDataView}`}>
        <div className="space-y-4">
          <div>
            <label className={`${textDataSecondary} text-xs mb-1 block`}>
              {t("serialView.hexBytes")}
            </label>
            <textarea
              value={serialEditor.hexInput}
              onChange={handleHexInputChange}
              placeholder={t("serialView.hexPlaceholder")}
              rows={4}
              className={`w-full ${bgDataInput} ${textDataPrimary} font-mono text-sm rounded px-3 py-2 border ${borderDataView} ${focusBorder} uppercase resize-none`}
            />
          </div>

          {/* Framing Mode */}
          <div className="space-y-2">
            <label className={`${textDataSecondary} text-xs`}>{t("serialView.framingMode")}</label>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => handleFramingModeChange("raw")}
                className={toggleChipClass(serialEditor.framingMode === "raw")}
              >
                {t("serialView.framingRaw")}
              </button>
              <button
                onClick={() => handleFramingModeChange("slip")}
                className={toggleChipClass(serialEditor.framingMode === "slip")}
              >
                {t("serialView.framingSlip")}
              </button>
              <button
                onClick={() => handleFramingModeChange("delimiter")}
                className={toggleChipClass(
                  serialEditor.framingMode === "delimiter"
                )}
              >
                {t("serialView.framingDelimiter")}
              </button>
            </div>
          </div>

          {/* Delimiter input (when delimiter mode selected) */}
          {serialEditor.framingMode === "delimiter" && (
            <div>
              <label className={`${textDataSecondary} text-xs mb-1 block`}>
                {t("serialView.delimiterLabel")}
              </label>
              <input
                type="text"
                value={serialEditor.delimiter.map(byteToHex).join(" ")}
                onChange={handleDelimiterChange}
                placeholder={t("serialView.delimiterPlaceholder")}
                className={`w-32 ${bgDataInput} ${textDataPrimary} font-mono text-sm rounded px-2 py-1.5 border ${borderDataView} ${focusBorder} uppercase`}
              />
              <p className={`${textDataSecondary} text-xs mt-1`}>
                {t("serialView.delimiterDefault")}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Preview */}
      {preview && (
        <div className={`px-4 py-3 ${bgDataToolbar} border-b ${borderDataView}`}>
          <div className="space-y-1">
            <div className="flex items-center gap-4">
              <span className={`${textDataSecondary} text-xs`}>{t("serialView.preview")}</span>
              <span className="text-xs text-blue-400">
                {t("serialView.bytesCount", { count: preview.length })}
              </span>
            </div>
            <div className="flex items-start gap-4">
              <code className={`font-mono text-sm flex-1 break-all ${textDataSecondary}`}>
                {preview.hex}
              </code>
            </div>
            <div className={flexRowGap2}>
              <span className={`${textDataSecondary} text-xs`}>{t("serialView.ascii")}</span>
              <code className={`font-mono text-xs ${textDataTertiary}`}>
                {preview.ascii}
              </code>
            </div>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className={`flex items-center gap-3 px-4 py-3 ${bgDataToolbar}`}>
        <button
          onClick={handleSend}
          disabled={!preview || isSending}
          className={`${buttonBase} ${preview && !isSending ? "bg-blue-600 hover:bg-blue-500" : ""}`}
          title={t("serialView.sendTooltip")}
        >
          <Send size={16} />
          <span>{isSending ? t("serialView.sending") : t("serialView.send")}</span>
        </button>

        <button
          onClick={handleAddToQueue}
          disabled={!preview}
          className={buttonBase}
          title={t("serialView.addToQueueTooltip")}
        >
          <Plus size={16} />
          <span>{t("serialView.addToQueue")}</span>
        </button>

        <div className="flex-1" />

        <button
          onClick={handleReset}
          className={buttonBase}
          title={t("serialView.resetTooltip")}
        >
          <RotateCcw size={14} />
          <span>{t("serialView.reset")}</span>
        </button>
      </div>
    </div>
  );
}
