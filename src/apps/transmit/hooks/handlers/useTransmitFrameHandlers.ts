// src/apps/transmit/hooks/handlers/useTransmitFrameHandlers.ts
//
// Handlers for transmitting CAN frames and serial bytes.
// Centralises transmission logic from CanTransmitView and SerialTransmitView.

import { useCallback, useState } from "react";
import { useTransmitStore } from "../../../../stores/transmitStore";
import { useActiveSession } from "../../../../stores/sessionStore";
import { ioTransmitSerial } from "../../../../api/transmit";
import { applyFraming } from "../../utils/slipFraming";

export interface UseTransmitFrameHandlersParams {
  /** Parsed serial bytes to transmit */
  serialBytes: number[];
}

export interface TransmitFrameHandlers {
  /** Send a CAN frame (uses store state) */
  handleSendCanFrame: () => Promise<void>;
  /** Add current CAN frame to queue */
  handleAddCanToQueue: () => void;
  /** Reset CAN editor to defaults */
  handleResetCanEditor: () => void;
  /** Send serial bytes with framing */
  handleSendSerialBytes: () => Promise<void>;
  /** Add current serial bytes to queue */
  handleAddSerialToQueue: () => void;
  /** Reset serial editor to defaults */
  handleResetSerialEditor: () => void;
  /** Whether a serial transmission is in progress */
  isSerialSending: boolean;
}

export function useTransmitFrameHandlers({
  serialBytes,
}: UseTransmitFrameHandlersParams): TransmitFrameHandlers {
  const activeSession = useActiveSession();

  // CAN store actions
  const sendCanFrame = useTransmitStore((s) => s.sendCanFrame);
  const addCanToQueue = useTransmitStore((s) => s.addCanToQueue);
  const resetCanEditor = useTransmitStore((s) => s.resetCanEditor);

  // Serial store actions
  const serialEditor = useTransmitStore((s) => s.serialEditor);
  const addSerialToQueue = useTransmitStore((s) => s.addSerialToQueue);
  const resetSerialEditor = useTransmitStore((s) => s.resetSerialEditor);
  const setActiveTab = useTransmitStore((s) => s.setActiveTab);
  const addHistoryItem = useTransmitStore((s) => s.addHistoryItem);

  // Local state for serial transmission
  const [isSerialSending, setIsSerialSending] = useState(false);

  // Send CAN frame
  const handleSendCanFrame = useCallback(async () => {
    await sendCanFrame();
  }, [sendCanFrame]);

  // Add CAN frame to queue
  const handleAddCanToQueue = useCallback(() => {
    addCanToQueue();
  }, [addCanToQueue]);

  // Reset CAN editor
  const handleResetCanEditor = useCallback(() => {
    resetCanEditor();
  }, [resetCanEditor]);

  // Send serial bytes with framing
  const handleSendSerialBytes = useCallback(async () => {
    if (!activeSession?.id || serialBytes.length === 0) return;

    // Apply framing based on editor settings
    const bytesToSend = applyFraming(
      serialBytes,
      serialEditor.framingMode,
      serialEditor.delimiter
    );

    setIsSerialSending(true);
    try {
      const result = await ioTransmitSerial(activeSession.id, bytesToSend);
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
      setIsSerialSending(false);
    }
  }, [
    activeSession,
    serialBytes,
    serialEditor.framingMode,
    serialEditor.delimiter,
    addHistoryItem,
  ]);

  // Add serial bytes to queue
  const handleAddSerialToQueue = useCallback(() => {
    addSerialToQueue();
    setActiveTab("queue");
  }, [addSerialToQueue, setActiveTab]);

  // Reset serial editor
  const handleResetSerialEditor = useCallback(() => {
    resetSerialEditor();
  }, [resetSerialEditor]);

  return {
    handleSendCanFrame,
    handleAddCanToQueue,
    handleResetCanEditor,
    handleSendSerialBytes,
    handleAddSerialToQueue,
    handleResetSerialEditor,
    isSerialSending,
  };
}

export type { TransmitFrameHandlers as TransmitFrameHandlersType };
