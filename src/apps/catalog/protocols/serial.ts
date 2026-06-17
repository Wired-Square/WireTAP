// ui/src/apps/catalog/protocols/serial.ts
// Serial/RS-485 protocol handler

import type { SerialConfig } from "../types";
import type { ProtocolHandler, ProtocolDefaults, ParsedFrame } from "./index";
import { readFrameInterval } from "./index";

const serialHandler: ProtocolHandler<SerialConfig> = {
  type: "serial",
  displayName: "Serial (RS-485)",
  icon: "Cable",

  parseFrame: (
    key: string,
    value: any,
    defaults: ProtocolDefaults,
    _allFrames?: Record<string, any>
  ): ParsedFrame<SerialConfig> => {
    // Interval can be inherited from catalog defaults
    let interval = readFrameInterval(value);
    let intervalInherited = false;

    if (interval === undefined && defaults.default_interval !== undefined) {
      interval = defaults.default_interval;
      intervalInherited = true;
    }

    // NOTE: Encoding comes from [frame.serial.config], not per-frame
    // It's passed via defaults.serialEncoding for reference only

    const signals = value.signals || value.signal || [];

    return {
      base: {
        length: value.length ?? 0,
        transmitter: value.transmitter,
        interval,
        notes: value.notes,
        signals,
        mux: value.mux,
      },
      config: {
        protocol: "serial",
        frame_id: key,
        delimiter: value.delimiter,
        // encoding NOT stored here - comes from [frame.serial.config]
      },
      inherited: {
        interval: intervalInherited,
      },
    };
  },

  serializeFrame: (_key, base, config, omitInherited) => {
    const obj: Record<string, any> = {};

    // NOTE: encoding is NOT written per-frame - it's in [frame.serial.config]

    // Length
    if (base.length !== undefined && base.length > 0) {
      obj.length = base.length;
    }

    // Delimiter (for raw encoding)
    if (config.delimiter && config.delimiter.length > 0) {
      obj.delimiter = config.delimiter;
    }

    if (base.transmitter) {
      obj.transmitter = base.transmitter;
    }

    // Only include interval if not inherited
    if (base.interval !== undefined && !omitInherited?.interval) {
      obj.interval_ms = base.interval;
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
    protocol: "serial",
    frame_id: "",
    delimiter: undefined,
    // encoding NOT here - comes from [frame.serial.config]
  }),

  getFrameDisplayId: (config) => {
    return config.frame_id || "(unnamed)";
  },

  getFrameDisplaySecondary: (_config) => {
    // Encoding info would need to come from catalog-level config
    // The caller should pass this separately if needed
    return undefined;
  },

  getFrameKey: (config) => {
    return config.frame_id || "unnamed_frame";
  },
};

export default serialHandler;
