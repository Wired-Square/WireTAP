// ui/src/apps/catalog/protocols/index.ts
// Protocol registry for generic frame handling

import type {
  ProtocolType,
  ProtocolConfig,
  BaseFrameFields,
  ValidationError,
} from "../types";

/**
 * Defaults passed to protocol handlers during parsing
 */
export interface ProtocolDefaults {
  default_interval?: number;
  default_endianness?: "little" | "big";
  // CAN config from [meta.can]
  default_extended?: boolean;
  default_fd?: boolean;
  // Modbus config from [meta.modbus]
  modbusDeviceAddress?: number;
  modbusRegisterBase?: 0 | 1;
  modbusDefaultInterval?: number;
  modbusDefaultByteOrder?: "big" | "little";
  modbusDefaultWordOrder?: "big" | "little";
  // Serial encoding from [meta.serial]
  serialEncoding?: "slip" | "cobs" | "raw" | "length_prefixed";
}

/**
 * Result of parsing a frame from TOML
 */
export interface ParsedFrame<T extends ProtocolConfig = ProtocolConfig> {
  base: BaseFrameFields;
  config: T;
  inherited: {
    length?: boolean;
    transmitter?: boolean;
    interval?: boolean;
    extended?: boolean;      // CAN-specific
    fd?: boolean;            // CAN-specific
    deviceAddress?: boolean; // Modbus-specific
    registerBase?: boolean;  // Modbus-specific
  };
}

/**
 * Protocol handler interface - each protocol implements this
 */
export interface ProtocolHandler<T extends ProtocolConfig = ProtocolConfig> {
  /** Protocol identifier */
  type: ProtocolType;

  /** Display name for UI */
  displayName: string;

  /** Icon name (lucide-react icon) */
  icon: string;

  /**
   * Parse a frame from TOML data
   * @param key - The TOML key (e.g., "0x123" for CAN, "battery_voltage" for Modbus)
   * @param value - The TOML value object
   * @param defaults - Default values from catalog meta
   * @param allFrames - All frames in this protocol section (for copy/inheritance)
   */
  parseFrame: (
    key: string,
    value: any,
    defaults: ProtocolDefaults,
    allFrames?: Record<string, any>
  ) => ParsedFrame<T>;

  /**
   * Serialize a frame back to TOML-compatible object
   * @param key - The frame key
   * @param base - Common frame fields
   * @param config - Protocol-specific config
   * @param omitInherited - Whether to omit inherited values
   */
  serializeFrame: (
    key: string,
    base: BaseFrameFields,
    config: T,
    omitInherited?: {
      length?: boolean;
      transmitter?: boolean;
      interval?: boolean;
      extended?: boolean;
      fd?: boolean;
      deviceAddress?: boolean;
      registerBase?: boolean;
    }
  ) => Record<string, any>;

  /**
   * Validate protocol-specific config
   * @param config - Config to validate
   * @param existingKeys - Existing frame keys (for duplicate detection)
   * @param originalKey - Original key if editing (to allow same key)
   */
  validateConfig: (
    config: T,
    existingKeys?: string[],
    originalKey?: string
  ) => ValidationError[];

  /**
   * Get default config for new frames
   */
  getDefaultConfig: () => T;

  /**
   * Get the display ID for a frame (shown in tree/UI)
   */
  getFrameDisplayId: (config: T) => string;

  /**
   * Get secondary display info (optional, shown in parentheses)
   */
  getFrameDisplaySecondary?: (config: T) => string | undefined;

  /**
   * Get the TOML key for a frame
   * For CAN this is the ID, for others it might be a friendly name
   */
  getFrameKey: (config: T) => string;
}

/**
 * Protocol registry singleton
 */
class ProtocolRegistry {
  private handlers = new Map<ProtocolType, ProtocolHandler>();

  /**
   * Register a protocol handler
   */
  register<T extends ProtocolConfig>(handler: ProtocolHandler<T>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.handlers.set(handler.type, handler as any);
  }

  /**
   * Get handler for a protocol type
   */
  get(type: ProtocolType): ProtocolHandler | undefined {
    return this.handlers.get(type);
  }

  /**
   * Get all registered handlers
   */
  all(): ProtocolHandler[] {
    return Array.from(this.handlers.values());
  }

  /**
   * Get all registered protocol types
   */
  types(): ProtocolType[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Check if a protocol is registered
   */
  has(type: string): type is ProtocolType {
    return this.handlers.has(type as ProtocolType);
  }
}

/** Global protocol registry instance */
export const protocolRegistry = new ProtocolRegistry();

// Import handlers - they export their handler objects but don't self-register
import canHandler from "./can";
import modbusHandler from "./modbus";
import serialHandler from "./serial";

// Register all protocol handlers
protocolRegistry.register(canHandler);
protocolRegistry.register(modbusHandler);
protocolRegistry.register(serialHandler);
