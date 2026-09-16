// ui/src/apps/catalog/protocols/can.ts
// CAN protocol handler

import type { CANConfig } from "../types";
import type { ProtocolHandler } from "./index";

const canHandler: ProtocolHandler<CANConfig> = {
  type: "can",
  displayName: "CAN",
  icon: "Network",

  serializeFrame: (_key, base, config, omitInherited) => {
    const obj: Record<string, any> = {};

    // Only include length if not inherited
    if (base.length !== undefined && !omitInherited?.length) {
      obj.length = base.length;
    }

    // Only include transmitter if not inherited
    if (base.transmitter && !omitInherited?.transmitter) {
      obj.transmitter = base.transmitter;
    }

    // Only include interval if not inherited
    if (base.interval !== undefined && !omitInherited?.interval) {
      obj.interval_ms = base.interval;
    }

    if (base.notes) {
      obj.notes = base.notes;
    }

    // CAN-specific fields
    if (config.extended !== undefined && !omitInherited?.extended) {
      obj.extended = config.extended;
    }

    if (config.fd !== undefined && !omitInherited?.fd) {
      obj.fd = config.fd;
    }

    if (config.bus !== undefined) {
      obj.bus = config.bus;
    }

    if (config.copy) {
      obj.copy = config.copy;
    }

    if (config.mirror_of) {
      obj.mirror_of = config.mirror_of;
    }

    // Signals and mux are handled separately in TOML structure
    if (base.signals && base.signals.length > 0) {
      obj.signals = base.signals;
    }

    if (base.mux) {
      obj.mux = base.mux;
    }

    return obj;
  },

  getDefaultConfig: () => ({
    protocol: "can",
    id: "",
    extended: undefined,
    fd: undefined,
    bus: undefined,
    copy: undefined,
    mirror_of: undefined,
  }),

  getFrameDisplayId: (config) => config.id,

  getFrameDisplaySecondary: (config) => {
    if (!config.id) return undefined;

    // Convert hex to decimal or vice versa for secondary display
    const isHex = /^0x[0-9a-fA-F]+$/i.test(config.id);
    if (isHex) {
      const numeric = parseInt(config.id, 16);
      return isNaN(numeric) ? undefined : String(numeric);
    } else {
      const numeric = parseInt(config.id, 10);
      return isNaN(numeric) ? undefined : `0x${numeric.toString(16).toUpperCase()}`;
    }
  },

  getFrameKey: (config) => config.id,
};

export default canHandler;
