// ui/src/apps/serial/hooks/useSerialTerminal.ts
//
// Owns one direct serial-terminal session: open the port, route inbound
// bytes to a callback, write bytes back. No IO session machinery — the
// Rust side keeps a per-terminal `serialport` handle and emits raw bytes
// on `serial-terminal-data`.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  closeSerialTerminal,
  openSerialTerminal,
  resetSerialTerminal,
  writeSerialTerminal,
  SERIAL_TERMINAL_DATA_EVENT,
  SERIAL_TERMINAL_ERROR_EVENT,
  type OpenSerialTerminalOptions,
  type SerialTerminalDataPayload,
  type SerialTerminalErrorPayload,
} from "../../../api/serialTerminal";
import { tlog } from "../../../api/settings";

interface UseSerialTerminalOptions {
  /** Called for every chunk of incoming bytes from the active terminal. */
  onData: (bytes: Uint8Array) => void;
  /** Called when the backend reports a port error (lost device, read fail). */
  onError?: (message: string) => void;
}

export interface UseSerialTerminalResult {
  terminalId: string | null;
  isOpen: boolean;
  isOpening: boolean;
  open: (opts: OpenSerialTerminalOptions) => Promise<void>;
  close: () => Promise<void>;
  write: (bytes: number[] | Uint8Array) => Promise<void>;
  /** Pulse RTS+DTR to reset the connected µC. */
  reset: () => Promise<void>;
}

export function useSerialTerminal(
  options: UseSerialTerminalOptions,
): UseSerialTerminalResult {
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);

  // Latest callbacks captured in refs so the listener doesn't re-subscribe
  // every time the parent re-renders.
  const onDataRef = useRef(options.onData);
  const onErrorRef = useRef(options.onError);
  useEffect(() => {
    onDataRef.current = options.onData;
  }, [options.onData]);
  useEffect(() => {
    onErrorRef.current = options.onError;
  }, [options.onError]);

  // Subscribe once for the lifetime of the hook; filter events by current id.
  // The `cancelled` flag covers React StrictMode's double-mount: if the
  // cleanup fires before listen()'s promise resolves, we still unlisten the
  // moment the handle arrives — otherwise the orphan listener stays alive
  // alongside the second mount's listener and every event fires twice.
  useEffect(() => {
    let cancelled = false;
    let unlistenData: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    listen<SerialTerminalDataPayload>(SERIAL_TERMINAL_DATA_EVENT, (e) => {
      if (e.payload.terminal_id !== terminalIdRef.current) return;
      onDataRef.current(new Uint8Array(e.payload.bytes));
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenData = fn;
    });
    listen<SerialTerminalErrorPayload>(SERIAL_TERMINAL_ERROR_EVENT, (e) => {
      if (e.payload.terminal_id !== terminalIdRef.current) return;
      tlog.info(`[Serial] terminal error: ${e.payload.message}`);
      onErrorRef.current?.(e.payload.message);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenError = fn;
    });
    return () => {
      cancelled = true;
      unlistenData?.();
      unlistenError?.();
    };
  }, []);

  // Mirror current terminal id into a ref for the event filter above.
  const terminalIdRef = useRef<string | null>(null);
  useEffect(() => {
    terminalIdRef.current = terminalId;
  }, [terminalId]);

  // If the component unmounts while a terminal is open, close it.
  useEffect(() => {
    return () => {
      const id = terminalIdRef.current;
      if (id) {
        closeSerialTerminal(id).catch(() => {});
      }
    };
  }, []);

  const open = useCallback(async (opts: OpenSerialTerminalOptions) => {
    setIsOpening(true);
    try {
      const id = await openSerialTerminal(opts);
      setTerminalId(id);
      terminalIdRef.current = id;
    } finally {
      setIsOpening(false);
    }
  }, []);

  const close = useCallback(async () => {
    const id = terminalIdRef.current;
    if (!id) return;
    try {
      await closeSerialTerminal(id);
    } catch (err) {
      tlog.info(`[Serial] close failed: ${err}`);
    } finally {
      setTerminalId(null);
      terminalIdRef.current = null;
    }
  }, []);

  const write = useCallback(async (bytes: number[] | Uint8Array) => {
    const id = terminalIdRef.current;
    if (!id) return;
    const arr = bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
    await writeSerialTerminal(id, arr);
  }, []);

  const reset = useCallback(async () => {
    const id = terminalIdRef.current;
    if (!id) return;
    await resetSerialTerminal(id);
  }, []);

  return {
    terminalId,
    isOpen: terminalId !== null,
    isOpening,
    open,
    close,
    write,
    reset,
  };
}
