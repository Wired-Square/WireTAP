// ui/src/apps/catalog/protocols/modbus.ts
// Modbus protocol handler

import type { ModbusConfig, ValidationError } from "../types";
import type { ProtocolHandler, ProtocolDefaults, ParsedFrame } from "./index";

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
    // Device address comes from [frame.modbus.config] - per-frame override not allowed
    const deviceAddress = defaults.modbusDeviceAddress;
    const deviceAddressInherited = deviceAddress !== undefined;

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
        register_number: value.register_number ?? 0,
        device_address: deviceAddress ?? 1,
        register_type: value.register_type ?? "holding",
        register_base: registerBase,
      },
      inherited: {
        interval: intervalInherited,
        deviceAddress: deviceAddressInherited,
        registerBase: registerBaseInherited,
      },
    };
  },

  serializeFrame: (_key, base, config, omitInherited) => {
    const obj: Record<string, any> = {};

    // Register number is always required
    obj.register_number = config.register_number;

    // Only include device_address if not inherited
    if (!omitInherited?.deviceAddress) {
      obj.device_address = config.device_address;
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

  validateConfig: (config, _existingKeys = [], _originalKey) => {
    const errors: ValidationError[] = [];

    // Validate register number
    if (config.register_number === undefined || config.register_number === null) {
      errors.push({ field: "register_number", message: "Register number is required" });
    } else if (!Number.isInteger(config.register_number) || config.register_number < 0 || config.register_number > 65535) {
      errors.push({
        field: "register_number",
        message: "Register number must be 0-65535",
      });
    }

    // Validate device address
    if (config.device_address === undefined || config.device_address === null) {
      errors.push({ field: "device_address", message: "Device address is required" });
    } else if (!Number.isInteger(config.device_address) || config.device_address < 1 || config.device_address > 247) {
      errors.push({
        field: "device_address",
        message: "Device address must be 1-247",
      });
    }

    // Validate register type
    const validTypes = ["holding", "input", "coil", "discrete"];
    if (config.register_type && !validTypes.includes(config.register_type)) {
      errors.push({
        field: "register_type",
        message: "Register type must be: holding, input, coil, or discrete",
      });
    }

    // Validate register base (if provided)
    if (config.register_base !== undefined && config.register_base !== 0 && config.register_base !== 1) {
      errors.push({
        field: "register_base",
        message: "Register base must be 0 or 1",
      });
    }

    // Note: We don't check for duplicate keys here since Modbus frames use
    // friendly names as keys, not register numbers. Duplicate names would be
    // caught by TOML parsing.

    return errors;
  },

  getDefaultConfig: () => ({
    protocol: "modbus",
    register_number: 0,
    device_address: 1,
    register_type: "holding",
  }),

  getFrameDisplayId: (config) => {
    return `Reg ${config.register_number}`;
  },

  getFrameDisplaySecondary: (config) => {
    return `Device ${config.device_address}`;
  },

  getFrameKey: (config) => {
    // For Modbus, the key is typically a friendly name, not derived from config
    // This is used when creating new frames
    return `register_${config.register_number}`;
  },
};

export default modbusHandler;
