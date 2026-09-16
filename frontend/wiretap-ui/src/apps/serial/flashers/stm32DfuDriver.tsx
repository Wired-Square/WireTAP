// src/apps/serial/flashers/stm32DfuDriver.tsx
//
// STM32 DFU driver record. Wraps the DFU 1.1 / DfuSe protocol via the
// `dfu-nusb` + `dfu-core` Rust crates. Independent of the serial port —
// the chip must already be in DFU mode (BOOT0 high + reset). Detection
// is implicit: if the user has a DFU device selected, this driver is
// active; chip metadata comes from the USB enumeration record itself.

import { flasherDfuCancel, flasherDfuFlash } from "../../../api/flashers";
import type { DfuDeviceInfo } from "../utils/flasherTypes";
import type { DriverOptionsPanelProps, FlasherDriver } from "./types";

/** DFU has no flasher options today — kernel does the timing for us, and
 *  there are no equivalents to ESP's flash baud / mode / freq. The empty
 *  panel keeps the layout consistent with the other drivers (the Flash
 *  view always reserves the options row, even if the driver doesn't use
 *  it) — we just render nothing inside. */
function DfuOptionsPanel(_props: DriverOptionsPanelProps<DfuDeviceInfo>) {
  return null;
}

export const stm32DfuDriver: FlasherDriver<DfuDeviceInfo> = {
  id: "stm32-dfu",
  manufacturer: "STM32 DFU",
  transport: "dfu",
  capabilities: { flash: true, backup: false, erase: false },
  OptionsPanel: DfuOptionsPanel,
  flash: async (handle, args) => {
    if (handle.kind !== "dfu") {
      throw new Error("STM32 DFU driver requires a DFU device");
    }
    return flasherDfuFlash(handle.serial, args.imagePath, args.address);
  },
  cancel: flasherDfuCancel,
  describeChip: (info) => ({
    label: info.display_name,
    subline: `${hexId(info.vid)}:${hexId(info.pid)} · ${info.serial}`,
  }),
  defaultFlashAddress: 0x0800_0000,
  imageExtensions: ["bin", "dfu", "hex"],
  backupExtension: "bin",
};

function hexId(n: number): string {
  return `0x${n.toString(16).padStart(4, "0")}`;
}
