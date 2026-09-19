// src/components/ManufacturerBadge.tsx
//
// Renders a coloured badge identifying the chip family of the device the
// user is flashing. Used by the Serial app's unified Flash view to make
// the active driver visually obvious — cyan for ESP32, amber for ESP8266,
// blue for STM32 (UART bootloader), purple for STM32 DFU.

import { Badge, type BadgeTone } from "./Badge";

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

const TONES: Record<Manufacturer, BadgeTone> = {
  ESP32: "cyan",
  ESP8266: "warning",
  STM32: "primary",
  "STM32 DFU": "purple",
  Unknown: "neutral",
};

export default function ManufacturerBadge({ manufacturer, className }: Props) {
  return (
    <Badge tone={TONES[manufacturer as Manufacturer] ?? "neutral"} size="lg" className={className}>
      {manufacturer}
    </Badge>
  );
}
