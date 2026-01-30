// ui/src/apps/transmit/views/CanTransmitView.tsx
//
// CAN frame editor and single-shot transmit view.

import { useCallback, useMemo } from "react";
import { Send, Plus, RotateCcw } from "lucide-react";
import { useTransmitStore } from "../../../stores/transmitStore";
import { useActiveSession } from "../../../stores/sessionStore";
import {
  bgDataToolbar,
  borderDataView,
  textDataSecondary,
} from "../../../styles/colourTokens";
import { playButtonBase, buttonBase } from "../../../styles/buttonStyles";
import { byteToHex } from "../../../utils/byteUtils";
import CanFrameEditor from "../components/CanFrameEditor";

export default function CanTransmitView() {
  // Store selectors
  const activeSession = useActiveSession();
  const canEditor = useTransmitStore((s) => s.canEditor);

  // Store actions
  const sendCanFrame = useTransmitStore((s) => s.sendCanFrame);
  const addCanToQueue = useTransmitStore((s) => s.addCanToQueue);
  const resetCanEditor = useTransmitStore((s) => s.resetCanEditor);

  // Get connection state
  const isConnected = activeSession?.lifecycleState === "connected";
  const canTransmit = activeSession?.capabilities?.can_transmit ?? false;

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
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
        <div className={`${textDataSecondary} text-center`}>
          <p className="text-lg font-medium">Not Connected</p>
          <p className="text-sm mt-2">
            Connect to an interface to transmit CAN frames.
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
          <p className="text-lg font-medium">CAN Not Supported</p>
          <p className="text-sm mt-2">
            This profile does not support CAN frame transmission.
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
            <span className={`${textDataSecondary} text-xs`}>Preview:</span>
            <code className="font-mono text-sm text-green-400">
              {framePreview.id}
            </code>
            <code className="font-mono text-sm text-blue-400">
              [{framePreview.dlc}]
            </code>
            <code className="font-mono text-sm text-gray-300">
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
          title="Send frame once"
        >
          <Send size={16} />
          <span>Send Once</span>
        </button>

        <button
          onClick={handleAddToQueue}
          disabled={!framePreview}
          className={buttonBase}
          title="Add to transmit queue"
        >
          <Plus size={16} />
          <span>Add to Queue</span>
        </button>

        <div className="flex-1" />

        <button
          onClick={handleReset}
          className={buttonBase}
          title="Reset to defaults"
        >
          <RotateCcw size={14} />
          <span>Reset</span>
        </button>
      </div>
    </div>
  );
}
