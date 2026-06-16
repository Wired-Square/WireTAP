// ui/src/apps/catalog/protocols/modbus.ts
// Modbus protocol handler

import type { ModbusConfig } from "../types";
import type { ProtocolHandler, ProtocolDefaults, ParsedFrame } from "./index";
import { parseCanIdToNumber } from "../utils";

/** True when a frame key is itself a register address (decimal or 0x-hex). */
export function isRegisterKey(key: string): boolean {
  return parseCanIdToNumber(key) !== null;
}

/** A Modbus frame's register comes from a numeric key OR an explicit
 *  `register_number`; with neither it's incomplete. Single source of truth for
 *  the form's inline warning and the save-time validation. */
export function modbusNeedsRegisterNumber(key: string, config: ModbusConfig): boolean {
  return !isRegisterKey(key) && config.register_number == null;
}

export const MODBUS_REGISTER_REQUIRED_MESSAGE =
  "Name isn't a register — enter a register number, or name the frame by its register (e.g. 2581 or 0x32F9).";

const modbusHandler: ProtocolHandler<ModbusConfig> = {
  type: "modbus",
  displayName: "Modbus",
  icon: "Server",

  parseFrame: (
    _key: string,
    value: any,
    defaults: ProtocolDefaults,
    _allFrames?: Record<string, any>
  ): ParsedFrame<ModbusConfig> => {
    // The device address now lives on the register's node, not the frame.

    // Register base comes from [frame.modbus.config] - per-frame override not allowed
    const registerBase = defaults.modbusRegisterBase;
    const registerBaseInherited = registerBase !== undefined;

    // Interval can be inherited from catalog defaults
    let interval = value.tx?.interval ?? value.tx?.interval_ms;
    let intervalInherited = false;

    if (interval === undefined && defaults.modbusDefaultInterval !== undefined) {
      interval = defaults.modbusDefaultInterval;
      intervalInherited = true;
    }

    const signals = value.signals || value.signal || [];

    return {
      base: {
        length: value.length ?? 1, // Default to 1 register
        transmitter: value.transmitter,
        interval,
        notes: value.notes,
        signals,
        mux: value.mux,
      },
      config: {
        protocol: "modbus",
        register_number: value.register_number,
        node: value.node,
        register_type: value.register_type ?? "holding",
        register_base: registerBase,
      },
      inherited: {
        interval: intervalInherited,
        registerBase: registerBaseInherited,
      },
    };
  },

  serializeFrame: (_key, base, config, omitInherited) => {
    const obj: Record<string, any> = {};

    // Register number is optional: write it only when set. When omitted, a
    // numeric frame key (`[frame.modbus.2581]`) supplies the register.
    if (config.register_number != null) {
      obj.register_number = config.register_number;
    }

    // The register's slave node (the node owns the device address).
    if (config.node) {
      obj.node = config.node;
    }

    // Only include register_base if not inherited and explicitly set
    if (config.register_base !== undefined && !omitInherited?.registerBase) {
      obj.register_base = config.register_base;
    }

    // Register type (default is "holding")
    if (config.register_type && config.register_type !== "holding") {
      obj.register_type = config.register_type;
    }

    // Length (number of registers)
    if (base.length !== undefined && base.length !== 1) {
      obj.length = base.length;
    }

    if (base.transmitter) {
      obj.transmitter = base.transmitter;
    }

    // Only include interval if not inherited
    if (base.interval !== undefined && !omitInherited?.interval) {
      obj.tx = { interval_ms: base.interval };
    }

    if (base.notes) {
      obj.notes = base.notes;
    }

    // Signals
    if (base.signals && base.signals.length > 0) {
      obj.signals = base.signals;
    }

    if (base.mux) {
      obj.mux = base.mux;
    }

    return obj;
  },

  getDefaultConfig: () => ({
    protocol: "modbus",
    register_type: "holding",
  }),

  getFrameDisplayId: (config) => {
    return config.register_number != null ? `Reg ${config.register_number}` : "Reg (from name)";
  },

  getFrameDisplaySecondary: (config) => {
    return config.node ? `Slave ${config.node}` : "No slave";
  },

  getFrameKey: (config) => {
    // Fallback only — the editor passes the user's chosen key (a register like
    // `2581`/`0x32F9`, or a friendly name) through to the upsert. This is used
    // by legacy callers that don't supply a key.
    return config.register_number != null ? `${config.register_number}` : "new_register";
  },
};

export default modbusHandler;
