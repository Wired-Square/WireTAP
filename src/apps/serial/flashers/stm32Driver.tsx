// src/apps/serial/flashers/stm32Driver.tsx
//
// STM32 UART (AN3155 system bootloader) driver record. Drives ST's ROM
// bootloader directly over the chosen serial port, with auto-pulse of
// BOOT0/NRST on RTS/DTR. Hardware that doesn't wire those lines can set
// both pins to "none" and put the chip in bootloader mode by hand.

import {
  flasherStm32Cancel,
  flasherStm32Erase,
  flasherStm32Flash,
  flasherStm32ReadFlash,
} from "../../../api/flashers";
import {
  bgSurface,
  borderDivider,
  textSecondary,
} from "../../../styles/colourTokens";
import { useFlasherStore } from "../stores/flasherStore";
import type {
  Stm32ChipInfo,
  Stm32PinSelection,
} from "../utils/flasherTypes";
import { Field, Select } from "./formHelpers";
import type { DriverOptionsPanelProps, FlasherDriver } from "./types";

const PIN_OPTIONS: { value: Stm32PinSelection; label: string }[] = [
  { value: "dtr", label: "DTR" },
  { value: "rts", label: "RTS" },
  { value: "none", label: "None" },
];

const BAUD_OPTIONS = [9600, 19200, 38400, 57600, 115200];

function Stm32OptionsPanel(_props: DriverOptionsPanelProps<Stm32ChipInfo>) {
  const options = useFlasherStore((s) => s.stm32Options);
  const setOptions = useFlasherStore((s) => s.setStm32Options);

  return (
    <div
      className={`p-3 ${bgSurface} ${borderDivider} border-b grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3`}
    >
      <Field label="BOOT0 pin">
        <Select
          value={options.boot0_pin ?? "dtr"}
          onChange={(v) => setOptions({ boot0_pin: v as Stm32PinSelection })}
          options={PIN_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label,
          }))}
        />
      </Field>
      <Field label="RESET pin">
        <Select
          value={options.reset_pin ?? "rts"}
          onChange={(v) => setOptions({ reset_pin: v as Stm32PinSelection })}
          options={PIN_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label,
          }))}
        />
      </Field>
      <Field label="Invert BOOT0">
        <label
          className={`flex items-center gap-1 text-xs ${textSecondary} px-1 py-1 cursor-pointer`}
        >
          <input
            type="checkbox"
            checked={options.boot0_invert ?? false}
            onChange={(e) => setOptions({ boot0_invert: e.target.checked })}
          />
          Active low
        </label>
      </Field>
      <Field label="Invert RESET">
        <label
          className={`flex items-center gap-1 text-xs ${textSecondary} px-1 py-1 cursor-pointer`}
        >
          <input
            type="checkbox"
            checked={options.reset_invert ?? true}
            onChange={(e) => setOptions({ reset_invert: e.target.checked })}
          />
          Active low
        </label>
      </Field>
      <Field label="Baud">
        <Select
          value={String(options.baud ?? 115_200)}
          onChange={(v) => setOptions({ baud: Number(v) })}
          options={BAUD_OPTIONS.map((b) => ({
            value: String(b),
            label: b.toLocaleString("en-AU"),
          }))}
        />
      </Field>
    </div>
  );
}

export const stm32Driver: FlasherDriver<Stm32ChipInfo> = {
  id: "stm32-uart",
  manufacturer: "STM32",
  transport: "serial",
  capabilities: { flash: true, backup: true, erase: true },
  OptionsPanel: Stm32OptionsPanel,
  flash: async (handle, args) => {
    if (handle.kind !== "serial") {
      throw new Error("STM32 UART driver requires a serial port");
    }
    const options = useFlasherStore.getState().stm32Options;
    return flasherStm32Flash(
      handle.port,
      args.imagePath,
      args.address,
      options,
    );
  },
  backup: async (handle, args) => {
    if (handle.kind !== "serial") {
      throw new Error("STM32 UART driver requires a serial port");
    }
    const options = useFlasherStore.getState().stm32Options;
    return flasherStm32ReadFlash(
      handle.port,
      args.outputPath,
      args.offset,
      args.size,
      options,
    );
  },
  erase: async (handle) => {
    if (handle.kind !== "serial") {
      throw new Error("STM32 UART driver requires a serial port");
    }
    const options = useFlasherStore.getState().stm32Options;
    return flasherStm32Erase(handle.port, options);
  },
  cancel: flasherStm32Cancel,
  describeChip: (chip) => {
    const parts: string[] = [chip.chip];
    parts.push(
      `PID 0x${chip.pid.toString(16).toUpperCase().padStart(4, "0")}`,
    );
    parts.push(`BL v${chip.bootloader_version}`);
    if (chip.flash_size_kb) parts.push(`${chip.flash_size_kb} KB flash`);
    const subline = chip.rdp_level ? `RDP ${chip.rdp_level}` : undefined;
    return { label: parts.join(" · "), subline };
  },
  defaultFlashAddress: 0x0800_0000,
  imageExtensions: ["bin", "hex"],
  backupExtension: "bin",
};
