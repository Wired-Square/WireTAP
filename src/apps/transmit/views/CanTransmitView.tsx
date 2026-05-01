// ui/src/apps/transmit/views/CanTransmitView.tsx
//
// CAN frame editor and single-shot transmit view.

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Send, Plus, RotateCcw } from "lucide-react";
import { useTransmitStore } from "../../../stores/transmitStore";
import { useActiveSession } from "../../../stores/sessionStore";
import {
  bgDataToolbar,
  borderDataView,
  textDataSecondary,
} from "../../../styles/colourTokens";
import { emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from "../../../styles/typography";
import { playButtonBase, buttonBase } from "../../../styles/buttonStyles";
import { byteToHex } from "../../../utils/byteUtils";
import CanFrameEditor from "../components/CanFrameEditor";

export default function CanTransmitView() {
  const { t } = useTranslation("transmit");
  // Store selectors
  const activeSession = useActiveSession();
  const canEditor = useTransmitStore((s) => s.canEditor);

  // Store actions
  const sendCanFrame = useTransmitStore((s) => s.sendCanFrame);
  const addCanToQueue = useTransmitStore((s) => s.addCanToQueue);
  const resetCanEditor = useTransmitStore((s) => s.resetCanEditor);

  // Get connection state
  const isConnected = activeSession?.lifecycleState === "connected";
  const canTransmit = activeSession?.capabilities?.traits.tx_frames ?? false;

  // Build frame preview
  const framePreview = useMemo(() => {
    const frameId = parseInt(canEditor.frameId, 16);
    if (isNaN(frameId)) return null;

    const maxId = canEditor.isExtended ? 0x1fffffff : 0x7ff;
    if (frameId > maxId) return null;

    return {
      id: canEditor.isExtended
        ? `0x${frameId.toString(16).toUpperCase().padStart(8, "0")}`
        : `0x${frameId.toString(16).toUpperCase().padStart(3, "0")}`,
      dlc: canEditor.dlc,
      data: canEditor.data.slice(0, canEditor.dlc).map(byteToHex).join(" "),
      flags: [
        canEditor.isExtended && "EXT",
        canEditor.isFd && "FD",
        canEditor.isBrs && "BRS",
        canEditor.isRtr && "RTR",
      ].filter(Boolean).join(" "),
    };
  }, [canEditor]);

  // Handle send
  const handleSend = useCallback(async () => {
    const result = await sendCanFrame();
    if (result?.success) {
      // Could show a flash notification here
    }
  }, [sendCanFrame]);

  // Handle add to queue
  const handleAddToQueue = useCallback(() => {
    addCanToQueue();
  }, [addCanToQueue]);

  // Handle reset
  const handleReset = useCallback(() => {
    resetCanEditor();
  }, [resetCanEditor]);

  // If not connected
  if (!isConnected) {
    return (
      <div className={emptyStateContainer}>
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>{t("canView.notConnectedHeading")}</p>
          <p className={emptyStateDescription}>
            {t("canView.notConnectedDescription")}
          </p>
        </div>
      </div>
    );
  }

  // If profile doesn't support CAN
  if (!canTransmit) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
        <div className={`${textDataSecondary} text-center`}>
          <p className="text-lg font-medium">{t("canView.notSupportedHeading")}</p>
          <p className="text-sm mt-2">
            {t("canView.notSupportedDescription")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Frame Editor */}
      <div className={`p-4 border-b ${borderDataView}`}>
        <CanFrameEditor />
      </div>

      {/* Frame Preview */}
      {framePreview && (
        <div className={`px-4 py-3 ${bgDataToolbar} border-b ${borderDataView}`}>
          <div className="flex items-center gap-4">
            <span className={`${textDataSecondary} text-xs`}>{t("canView.preview")}</span>
            <code className="font-mono text-sm text-green-400">
              {framePreview.id}
            </code>
            <code className="font-mono text-sm text-blue-400">
              [{framePreview.dlc}]
            </code>
            <code className={`font-mono text-sm ${textDataSecondary}`}>
              {framePreview.data}
            </code>
            {framePreview.flags && (
              <span className="text-xs text-amber-400">{framePreview.flags}</span>
            )}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className={`flex items-center gap-3 px-4 py-3 ${bgDataToolbar}`}>
        <button
          onClick={handleSend}
          disabled={!framePreview}
          className={playButtonBase}
          title={t("canView.sendOnceTooltip")}
        >
          <Send size={16} />
          <span>{t("canView.sendOnce")}</span>
        </button>

        <button
          onClick={handleAddToQueue}
          disabled={!framePreview}
          className={buttonBase}
          title={t("canView.addToQueueTooltip")}
        >
          <Plus size={16} />
          <span>{t("canView.addToQueue")}</span>
        </button>

        <div className="flex-1" />

        <button
          onClick={handleReset}
          className={buttonBase}
          title={t("canView.resetTooltip")}
        >
          <RotateCcw size={14} />
          <span>{t("canView.reset")}</span>
        </button>
      </div>
    </div>
  );
}
