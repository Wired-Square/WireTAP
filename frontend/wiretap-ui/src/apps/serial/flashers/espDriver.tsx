// src/apps/serial/flashers/espDriver.tsx
//
// ESP32-family flasher driver record. Wraps Espressif's esptool protocol via
// the `espflash` Rust crate. The OptionsPanel exposes flash baud / mode /
// freq / size + a manual chip override; everything else is auto-detected.

import { useEffect } from "react";
import {
  flasherEspCancel,
  flasherEspErase,
  flasherEspFlash,
  flasherEspReadFlash,
} from "../../../api/flashers";
import {
  bgSurface,
  borderDivider,
} from "../../../styles/colourTokens";
import { useFlasherStore } from "../stores/flasherStore";
import type { EspChipInfo } from "../utils/flasherTypes";
import { Field, Select } from "./formHelpers";
import type { DriverOptionsPanelProps, FlasherDriver } from "./types";

const CHIP_OPTIONS = [
  { value: "auto", label: "Auto-detect" },
  { value: "esp32", label: "ESP32" },
  { value: "esp32s2", label: "ESP32-S2" },
  { value: "esp32s3", label: "ESP32-S3" },
  { value: "esp32c2", label: "ESP32-C2" },
  { value: "esp32c3", label: "ESP32-C3" },
  { value: "esp32c5", label: "ESP32-C5" },
  { value: "esp32c6", label: "ESP32-C6" },
  { value: "esp32c61", label: "ESP32-C61" },
  { value: "esp32h2", label: "ESP32-H2" },
  { value: "esp32p4", label: "ESP32-P4" },
] as const;

const FLASH_BAUD_OPTIONS = [
  115_200, 230_400, 460_800, 921_600, 1_500_000, 2_000_000,
];

const FLASH_MODE_OPTIONS = ["dio", "qio", "qout", "dout"] as const;
const FLASH_FREQ_OPTIONS = ["20MHz", "26MHz", "40MHz", "80MHz"] as const;
const FLASH_SIZE_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "1MB", label: "1 MB" },
  { value: "2MB", label: "2 MB" },
  { value: "4MB", label: "4 MB" },
  { value: "8MB", label: "8 MB" },
  { value: "16MB", label: "16 MB" },
  { value: "32MB", label: "32 MB" },
] as const;

function EspOptionsPanel({ chip }: DriverOptionsPanelProps<EspChipInfo>) {
  const options = useFlasherStore((s) => s.espOptions);
  const setOptions = useFlasherStore((s) => s.setEspOptions);

  // Default the flash-size dropdown off the detected chip the first time
  // we see one. Leave any manual override alone on subsequent detects.
  useEffect(() => {
    if (!chip || options.flash_size) return;
    if (!chip.flash_size_bytes) return;
    const mb = Math.round(chip.flash_size_bytes / 1024 / 1024);
    const match = FLASH_SIZE_OPTIONS.find((opt) => opt.value === `${mb}MB`);
    if (match) setOptions({ flash_size: match.value });
  }, [chip, options.flash_size, setOptions]);

  return (
    <div
      className={`p-3 ${bgSurface} ${borderDivider} border-b grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3`}
    >
      <Field label="Chip">
        <Select
          value={options.chip ?? "auto"}
          onChange={(v) => setOptions({ chip: v === "auto" ? null : v })}
          options={CHIP_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </Field>
      <Field label="Flash baud">
        <Select
          value={String(options.flash_baud ?? 460_800)}
          onChange={(v) => setOptions({ flash_baud: Number(v) })}
          options={FLASH_BAUD_OPTIONS.map((b) => ({
            value: String(b),
            label: b.toLocaleString("en-AU"),
          }))}
        />
      </Field>
      <Field label="Flash mode">
        <Select
          value={options.flash_mode ?? "dio"}
          onChange={(v) => setOptions({ flash_mode: v })}
          options={FLASH_MODE_OPTIONS.map((m) => ({ value: m, label: m }))}
        />
      </Field>
      <Field label="Flash freq">
        <Select
          value={options.flash_freq ?? "40MHz"}
          onChange={(v) => setOptions({ flash_freq: v })}
          options={FLASH_FREQ_OPTIONS.map((f) => ({ value: f, label: f }))}
        />
      </Field>
      <Field label="Flash size">
        <Select
          value={options.flash_size ?? "auto"}
          onChange={(v) => setOptions({ flash_size: v === "auto" ? null : v })}
          options={FLASH_SIZE_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label,
          }))}
        />
      </Field>
    </div>
  );
}

export const espDriver: FlasherDriver<EspChipInfo> = {
  id: "esp-uart",
  manufacturer: "ESP32",
  transport: "serial",
  capabilities: { flash: true, backup: true, erase: true },
  OptionsPanel: EspOptionsPanel,
  flash: async (handle, args) => {
    if (handle.kind !== "serial") {
      throw new Error("ESP driver requires a serial port");
    }
    const options = useFlasherStore.getState().espOptions;
    return flasherEspFlash(handle.port, args.imagePath, args.address, options);
  },
  backup: async (handle, args) => {
    if (handle.kind !== "serial") {
      throw new Error("ESP driver requires a serial port");
    }
    const options = useFlasherStore.getState().espOptions;
    return flasherEspReadFlash(
      handle.port,
      args.outputPath,
      args.offset,
      args.size,
      options,
    );
  },
  erase: async (handle) => {
    if (handle.kind !== "serial") {
      throw new Error("ESP driver requires a serial port");
    }
    const options = useFlasherStore.getState().espOptions;
    return flasherEspErase(handle.port, options);
  },
  cancel: flasherEspCancel,
  describeChip: (chip) => {
    const parts: string[] = [chip.chip];
    if (chip.flash_size_bytes) {
      parts.push(`${Math.round(chip.flash_size_bytes / 1024 / 1024)} MB flash`);
    }
    return {
      label: parts.join(" · "),
      subline: `MAC ${chip.mac}`,
    };
  },
  defaultFlashAddress: 0x0,
  imageExtensions: ["bin", "elf"],
  backupExtension: "bin",
};
