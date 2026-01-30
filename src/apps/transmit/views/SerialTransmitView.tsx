// ui/src/apps/transmit/views/SerialTransmitView.tsx
//
// Serial bytes editor and single-shot transmit view.

import { useCallback, useMemo, useState } from "react";
import { Plus, RotateCcw, Send } from "lucide-react";
import { useTransmitStore } from "../../../stores/transmitStore";
import { useActiveSession } from "../../../stores/sessionStore";
import { ioTransmitSerial } from "../../../api/transmit";
import {
  bgDataToolbar,
  borderDataView,
  textDataPrimary,
  bgDataInput,
  textDataSecondary,
} from "../../../styles/colourTokens";
import { buttonBase, toggleChipClass } from "../../../styles/buttonStyles";
import { flexRowGap2 } from "../../../styles/spacing";
import { byteToHex, hexToBytes } from "../../../utils/byteUtils";

export default function SerialTransmitView() {
  // Store selectors
  const activeSession = useActiveSession();
  const serialEditor = useTransmitStore((s) => s.serialEditor);

  // Store actions
  const updateSerialEditor = useTransmitStore((s) => s.updateSerialEditor);
  const addSerialToQueue = useTransmitStore((s) => s.addSerialToQueue);
  const resetSerialEditor = useTransmitStore((s) => s.resetSerialEditor);
  const setActiveTab = useTransmitStore((s) => s.setActiveTab);
  const addHistoryItem = useTransmitStore((s) => s.addHistoryItem);

  // Local state for transmit
  const [isSending, setIsSending] = useState(false);

  // Get connection state and capabilities
  const isConnected = activeSession?.lifecycleState === "connected";
  const canTransmit = isConnected && activeSession?.capabilities?.can_transmit_serial === true;

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

    // Apply framing if needed
    let bytesToSend = [...parsedBytes];
    if (serialEditor.framingMode === "slip") {
      // SLIP framing: END(0xC0), escape special chars, END(0xC0)
      const SLIP_END = 0xc0;
      const SLIP_ESC = 0xdb;
      const SLIP_ESC_END = 0xdc;
      const SLIP_ESC_ESC = 0xdd;
      const framed: number[] = [SLIP_END];
      for (const b of parsedBytes) {
        if (b === SLIP_END) {
          framed.push(SLIP_ESC, SLIP_ESC_END);
        } else if (b === SLIP_ESC) {
          framed.push(SLIP_ESC, SLIP_ESC_ESC);
        } else {
          framed.push(b);
        }
      }
      framed.push(SLIP_END);
      bytesToSend = framed;
    } else if (serialEditor.framingMode === "delimiter") {
      // Append delimiter
      bytesToSend = [...parsedBytes, ...serialEditor.delimiter];
    }

    setIsSending(true);
    try {
      const result = await ioTransmitSerial(activeSession.id, bytesToSend);
      // Add to history
      addHistoryItem({
        timestamp_us: result.timestamp_us,
        profileId: activeSession.id,
        profileName: activeSession.profileId ?? "Serial",
        type: "serial",
        bytes: bytesToSend,
        success: result.success,
        error: result.error,
      });
    } catch (e) {
      console.error("Serial transmit failed:", e);
      addHistoryItem({
        timestamp_us: Date.now() * 1000,
        profileId: activeSession.id,
        profileName: activeSession.profileId ?? "Serial",
        type: "serial",
        bytes: bytesToSend,
        success: false,
        error: String(e),
      });
    } finally {
      setIsSending(false);
    }
  }, [activeSession, parsedBytes, serialEditor.framingMode, serialEditor.delimiter, addHistoryItem]);

  // If not connected
  if (!isConnected) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
        <div className={`${textDataSecondary} text-center`}>
          <p className="text-lg font-medium">Not Connected</p>
          <p className="text-sm mt-2">
            Connect to an interface to transmit serial bytes.
          </p>
        </div>
      </div>
    );
  }

  // If profile doesn't support serial
  if (!canTransmit) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
        <div className={`${textDataSecondary} text-center`}>
          <p className="text-lg font-medium">Serial Not Supported</p>
          <p className="text-sm mt-2">
            This profile does not support serial byte transmission.
          </p>
          <p className="text-xs mt-1 text-gray-500">
            Only serial profiles support raw byte transmission.
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
              Hex Bytes
            </label>
            <textarea
              value={serialEditor.hexInput}
              onChange={handleHexInputChange}
              placeholder="AA BB CC DD EE FF..."
              rows={4}
              className={`w-full ${bgDataInput} ${textDataPrimary} font-mono text-sm rounded px-3 py-2 border ${borderDataView} focus:outline-none focus:border-blue-500 uppercase resize-none`}
            />
          </div>

          {/* Framing Mode */}
          <div className="space-y-2">
            <label className={`${textDataSecondary} text-xs`}>Framing Mode:</label>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => handleFramingModeChange("raw")}
                className={toggleChipClass(serialEditor.framingMode === "raw")}
              >
                Raw (No Framing)
              </button>
              <button
                onClick={() => handleFramingModeChange("slip")}
                className={toggleChipClass(serialEditor.framingMode === "slip")}
              >
                SLIP
              </button>
              <button
                onClick={() => handleFramingModeChange("delimiter")}
                className={toggleChipClass(
                  serialEditor.framingMode === "delimiter"
                )}
              >
                Delimiter
              </button>
            </div>
          </div>

          {/* Delimiter input (when delimiter mode selected) */}
          {serialEditor.framingMode === "delimiter" && (
            <div>
              <label className={`${textDataSecondary} text-xs mb-1 block`}>
                Delimiter (hex)
              </label>
              <input
                type="text"
                value={serialEditor.delimiter.map(byteToHex).join(" ")}
                onChange={handleDelimiterChange}
                placeholder="0D 0A"
                className={`w-32 ${bgDataInput} ${textDataPrimary} font-mono text-sm rounded px-2 py-1.5 border ${borderDataView} focus:outline-none focus:border-blue-500 uppercase`}
              />
              <p className={`${textDataSecondary} text-xs mt-1`}>
                Default: 0D 0A (CRLF)
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
              <span className={`${textDataSecondary} text-xs`}>Preview:</span>
              <span className="text-xs text-blue-400">
                {preview.length} bytes
              </span>
            </div>
            <div className="flex items-start gap-4">
              <code className="font-mono text-sm text-gray-300 flex-1 break-all">
                {preview.hex}
              </code>
            </div>
            <div className={flexRowGap2}>
              <span className={`${textDataSecondary} text-xs`}>ASCII:</span>
              <code className="font-mono text-xs text-gray-500">
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
          title="Send bytes now"
        >
          <Send size={16} />
          <span>{isSending ? "Sending..." : "Send"}</span>
        </button>

        <button
          onClick={handleAddToQueue}
          disabled={!preview}
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
