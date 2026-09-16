// src/apps/serial/flashers/useChipDetection.ts
//
// Auto-detect the chip family on the active device and populate the
// flasher store's `chip` + `activeDriverId`. Two paths:
//
//   - Serial port:  `flasher_serial_detect` (probes STM32 then ESP).
//   - DFU device:   manufacturer string from the USB enumeration record.
//
// Detection runs on entry to the Flash tab and whenever the selected port
// or DFU serial changes — keyed off the device id so we don't spin
// re-detecting the same one. Skipped while the Terminal owns the port.

import { useCallback, useEffect, useRef, useState } from "react";

import { flasherSerialDetect } from "../../../api/flashers";
import { tlog } from "../../../api/settings";
import { useFlasherStore, type DetectedChipState } from "../stores/flasherStore";
import type { DfuDeviceInfo } from "../utils/flasherTypes";
import { driverIdForDfu } from "./registry";

interface Options {
  /** Active serial port name (`null` if the user picked a DFU device). */
  serialPort: string | null;
  /** Currently selected DFU device, if any. */
  dfuDevice: DfuDeviceInfo | null;
  /** True while the Terminal tab has the port open. We skip auto-detect
   *  in that case so the live session isn't interrupted — the user can
   *  still hit Detect manually (which hands the port over). */
  isTerminalOpen: boolean;
  /** Hand the port over from the terminal before we probe. The parent
   *  remembers whether the terminal was open and reopens it once the
   *  detect settles. */
  onBeforeProbe: () => Promise<void>;
}

interface ChipDetectionState {
  /** True while a detect is in flight (manual or automatic). */
  busy: boolean;
  /** Last detect error message, or `null` if the last attempt succeeded. */
  error: string | null;
  /** Trigger a re-detect from a button click. Always honoured, even if
   *  the device id matches the cached one. */
  detect: () => Promise<void>;
}

export function useChipDetection({
  serialPort,
  dfuDevice,
  isTerminalOpen,
  onBeforeProbe,
}: Options): ChipDetectionState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastDetectedKeyRef = useRef<string | null>(null);

  const setChip = useFlasherStore((s) => s.setChip);
  const setActiveDriver = useFlasherStore((s) => s.setActiveDriver);
  const stm32Options = useFlasherStore((s) => s.stm32Options);

  // Stable string id for the current device — `serial:<port>` or
  // `dfu:<usb-serial>`. `null` means no device selected.
  const deviceKey = serialPort
    ? `serial:${serialPort}`
    : dfuDevice
      ? `dfu:${dfuDevice.serial}`
      : null;

  const runDfuDetection = useCallback(
    (device: DfuDeviceInfo) => {
      const driverId = driverIdForDfu(device.manufacturer);
      if (!driverId) {
        setError(`No driver for DFU device "${device.manufacturer}"`);
        setActiveDriver(null);
        setChip(null);
        return;
      }
      const detected: DetectedChipState = {
        driverId,
        manufacturer: device.manufacturer,
        chipName: device.display_name,
        flashSizeKb: null,
        raw: device,
      };
      setActiveDriver(driverId);
      setChip(detected);
      setError(null);
    },
    [setActiveDriver, setChip],
  );

  const runSerialDetection = useCallback(
    async (port: string, silent: boolean) => {
      setBusy(true);
      setError(null);
      try {
        await onBeforeProbe();
        const result = await flasherSerialDetect(port, stm32Options);
        const driverId = result.driver_id as DetectedChipState["driverId"];
        const detected: DetectedChipState = {
          driverId,
          manufacturer: result.manufacturer,
          chipName: result.chip_name,
          flashSizeKb: result.flash_size_kb ?? null,
          raw: result.extra,
        };
        setActiveDriver(driverId);
        setChip(detected);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!silent) tlog.info(`[Serial/Flash] detect failed: ${msg}`);
        setActiveDriver(null);
        setChip(null);
        setError(msg);
      } finally {
        setBusy(false);
      }
    },
    [onBeforeProbe, stm32Options, setActiveDriver, setChip],
  );

  // Detect whenever the device id changes (and we're allowed to probe).
  useEffect(() => {
    if (!deviceKey) {
      lastDetectedKeyRef.current = null;
      setActiveDriver(null);
      setChip(null);
      setError(null);
      return;
    }
    if (lastDetectedKeyRef.current === deviceKey) return;

    if (dfuDevice) {
      lastDetectedKeyRef.current = deviceKey;
      runDfuDetection(dfuDevice);
      return;
    }

    if (serialPort) {
      if (isTerminalOpen) return;
      lastDetectedKeyRef.current = deviceKey;
      void runSerialDetection(serialPort, true);
    }
  }, [
    deviceKey,
    dfuDevice,
    serialPort,
    isTerminalOpen,
    runDfuDetection,
    runSerialDetection,
    setActiveDriver,
    setChip,
  ]);

  // Manual re-detect from the status-bar button. Bypasses the cached id.
  const detect = useCallback(async () => {
    if (dfuDevice) {
      lastDetectedKeyRef.current = deviceKey;
      runDfuDetection(dfuDevice);
      return;
    }
    if (serialPort) {
      lastDetectedKeyRef.current = deviceKey;
      await runSerialDetection(serialPort, false);
    }
  }, [
    deviceKey,
    dfuDevice,
    serialPort,
    runDfuDetection,
    runSerialDetection,
  ]);

  return { busy, error, detect };
}
