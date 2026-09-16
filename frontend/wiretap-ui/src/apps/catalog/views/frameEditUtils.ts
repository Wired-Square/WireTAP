// ui/src/apps/catalog/views/frameEditUtils.ts
// Utility functions for frame editing - separated for Fast Refresh compatibility

import type {
  ProtocolType,
  CANConfig,
  SerialConfig,
} from "../types";
import { protocolRegistry } from "../protocols";
import type { FrameEditFields } from "./FrameEditView";

/**
 * Create default fields for a new frame of the given protocol
 */
export function createDefaultFrameFields(
  protocol: ProtocolType,
  _defaults?: {
    serialEncoding?: "slip" | "cobs" | "raw" | "length_prefixed";
  }
): FrameEditFields {
  const handler = protocolRegistry.get(protocol);
  if (!handler) {
    throw new Error(`Unknown protocol: ${protocol}`);
  }

  const config = handler.getDefaultConfig();
  // NOTE: For serial, encoding is NOT in config - it's catalog-level in [frame.serial.config]

  return {
    protocol,
    config,
    base: {
      length: protocol === "can" ? 8 : protocol === "modbus" ? 1 : 0,
    },
    modbusFrameKey: protocol === "modbus" ? "" : undefined,
  };
}

/**
 * Check if the frame fields are valid enough to save
 */
export function isFrameFieldsValid(fields: FrameEditFields): boolean {
  const handler = protocolRegistry.get(fields.protocol);
  if (!handler) return false;

  // Protocol-specific checks
  switch (fields.protocol) {
    case "can": {
      const config = fields.config as CANConfig;
      return !!config.id?.trim();
    }
    case "modbus": {
      return !!fields.modbusFrameKey?.trim();
    }
    case "serial": {
      const config = fields.config as SerialConfig;
      return !!config.frame_id?.trim();
    }
    default:
      return false;
  }
}
