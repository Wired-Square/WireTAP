// src/utils/ioKindLabel.ts
//
// Human-readable labels for IO profile kind values.

/**
 * Convert a profile `kind` value to a human-readable label.
 * e.g., "gvret_tcp" -> "GVRET TCP", "csv_file" -> "CSV File"
 */
export function getIOKindLabel(kind: string | undefined): string {
  switch (kind) {
    case "mqtt":
      return "MQTT";
    case "postgres":
      return "PostgreSQL";
    case "gvret_tcp":
      return "GVRET TCP";
    case "gvret_usb":
      return "GVRET USB";
    case "csv_file":
      return "CSV File";
    case "serial":
      return "Serial";
    case "slcan":
      return "slcan";
    case "socketcan":
      return "SocketCAN";
    case "gs_usb":
      return "gs_usb";
    case "modbus_tcp":
      return "Modbus TCP";
    default:
      return kind ?? "Unknown";
  }
}
