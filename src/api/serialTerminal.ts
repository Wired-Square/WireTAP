// ui/src/api/serialTerminal.ts
//
// Direct serial-terminal API. Bypasses the multi-source IO session pipeline
// — the backend opens a dedicated serialport handle per terminal id and
// emits raw bytes on `serial-terminal-data`.

import { invoke } from "@tauri-apps/api/core";

export const SERIAL_TERMINAL_DATA_EVENT = "serial-terminal-data";
export const SERIAL_TERMINAL_ERROR_EVENT = "serial-terminal-error";

export interface SerialTerminalDataPayload {
  terminal_id: string;
  bytes: number[];
}

export interface SerialTerminalErrorPayload {
  terminal_id: string;
  message: string;
}

export interface OpenSerialTerminalOptions {
  port: string;
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "odd" | "even";
}

export async function openSerialTerminal(
  opts: OpenSerialTerminalOptions,
): Promise<string> {
  return invoke("serial_terminal_open", {
    port: opts.port,
    baud_rate: opts.baudRate,
    data_bits: opts.dataBits,
    stop_bits: opts.stopBits,
    parity: opts.parity,
  });
}

export async function closeSerialTerminal(terminalId: string): Promise<void> {
  await invoke("serial_terminal_close", { terminal_id: terminalId });
}

export async function writeSerialTerminal(
  terminalId: string,
  bytes: number[],
): Promise<void> {
  await invoke("serial_terminal_write", { terminal_id: terminalId, bytes });
}

/**
 * Pulse RTS+DTR low → high to reset the connected µC. Works for boards
 * that route reset through either control line (ESP32 EN, Arduino DTR,
 * etc.).
 */
export async function resetSerialTerminal(terminalId: string): Promise<void> {
  await invoke("serial_terminal_reset", { terminal_id: terminalId });
}
