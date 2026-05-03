// src/components/ManufacturerBadge.tsx
//
// Renders a coloured badge identifying the chip family of the device the
// user is flashing. Used by the Serial app's unified Flash view to make
// the active driver visually obvious — cyan for ESP32, amber for ESP8266,
// sky for STM32 (UART bootloader), violet for STM32 DFU.

import {
  badgeManufacturerEsp32,
  badgeManufacturerEsp8266,
  badgeManufacturerStm32,
  badgeManufacturerStm32Dfu,
  badgeManufacturerUnknown,
} from "../styles/badgeStyles";

export type Manufacturer =
  | "ESP32"
  | "ESP8266"
  | "STM32"
  | "STM32 DFU"
  | "Unknown";

interface Props {
  /** Manufacturer string from the backend or a driver record. Anything we
   *  don't recognise falls through to the generic "Unknown" badge. */
  manufacturer: string;
  className?: string;
}

function classFor(m: string): string {
  switch (m) {
    case "ESP32":
      return badgeManufacturerEsp32;
    case "ESP8266":
      return badgeManufacturerEsp8266;
    case "STM32":
      return badgeManufacturerStm32;
    case "STM32 DFU":
      return badgeManufacturerStm32Dfu;
    default:
      return badgeManufacturerUnknown;
  }
}

export default function ManufacturerBadge({ manufacturer, className }: Props) {
  return (
    <span className={`${classFor(manufacturer)} ${className ?? ""}`.trim()}>
      {manufacturer}
    </span>
  );
}
