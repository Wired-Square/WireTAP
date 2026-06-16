// ui/src/apps/catalog/protocols/can.ts
// CAN protocol handler

import type { CANConfig } from "../types";
import type { ProtocolHandler, ProtocolDefaults, ParsedFrame } from "./index";
import { findFrameByNumericId } from "../../../utils/catalogParser";

const canHandler: ProtocolHandler<CANConfig> = {
  type: "can",
  displayName: "CAN",
  icon: "Network",

  parseFrame: (
    key: string,
    value: any,
    defaults: ProtocolDefaults,
    allFrames?: Record<string, any>
  ): ParsedFrame<CANConfig> => {
    let length = value.length;
    let lengthInherited = false;
    let transmitter = value.transmitter;
    let transmitterInherited = false;
    let interval = value.tx?.interval ?? value.tx?.interval_ms;
    let intervalInherited = false;

    // Resolve extended: frame explicit > catalog default > auto-detect from ID
    let extended: boolean | undefined;
    let extendedInherited = false;
    if (typeof value.extended === 'boolean') {
      extended = value.extended;
    } else if (typeof defaults.default_extended === 'boolean') {
      extended = defaults.default_extended;
      extendedInherited = true;
    } else {
      // Auto-detect from ID value
      const numId = key.startsWith('0x') ? parseInt(key, 16) : parseInt(key, 10);
      extended = !isNaN(numId) && numId > 0x7ff;
      extendedInherited = true;  // Mark as inherited since it's auto-detected
    }

    // Resolve fd: frame explicit > catalog default > false
    let fd: boolean | undefined;
    let fdInherited = false;
    if (typeof value.fd === 'boolean') {
      fd = value.fd;
    } else if (typeof defaults.default_fd === 'boolean') {
      fd = defaults.default_fd;
      fdInherited = true;
    }
    // If neither set, fd remains undefined (classic CAN)

    const isCopy = !!value.copy;
    const copyFrom = value.copy;
    const isMirror = !!value.mirror_of;
    const mirrorOf = value.mirror_of;

    // Handle copy/inheritance from another CAN frame (metadata only)
    const copySource = isCopy && copyFrom && allFrames ? findFrameByNumericId(copyFrom, allFrames) : undefined;
    if (copySource) {
      const sourceFrame = copySource;
      if (length === undefined && sourceFrame.length !== undefined) {
        length = sourceFrame.length;
        lengthInherited = true;
      }
      if (transmitter === undefined && sourceFrame.transmitter !== undefined) {
        transmitter = sourceFrame.transmitter;
        transmitterInherited = true;
      }
      const srcInterval = sourceFrame.tx?.interval ?? sourceFrame.tx?.interval_ms;
      if (interval === undefined && srcInterval !== undefined) {
        interval = srcInterval;
        intervalInherited = true;
      }
    }

    // Inherit interval from catalog defaults
    if (interval === undefined && defaults.default_interval !== undefined) {
      interval = defaults.default_interval;
      intervalInherited = true;
    }

    let signals = value.signals || value.signal || [];
    let mux = value.mux;

    // Handle mirror inheritance (signals + metadata)
    // Mirror signals override primary signals by bit position
    const mirrorSource = isMirror && mirrorOf && allFrames ? findFrameByNumericId(mirrorOf, allFrames) : undefined;
    if (mirrorSource) {
      const primaryFrame = mirrorSource;
      const primarySignals = primaryFrame.signals || primaryFrame.signal || [];
      const mirrorSignals = signals;

      // Build a map of mirror signals by bit position for override lookup
      const bitKey = (s: any) => `${s.start_bit}:${s.bit_length}`;
      const mirrorByPosition = new Map(mirrorSignals.map((s: any) => [bitKey(s), s]));

      // Start with primary signals, override by bit position
      // Mark inherited signals with _inherited: true
      signals = primarySignals.map((ps: any) => {
        const override = mirrorByPosition.get(bitKey(ps));
        if (override) {
          return override; // Overridden by mirror - not inherited
        }
        return { ...ps, _inherited: true }; // Inherited from primary
      });

      // Add any mirror signals at new positions (not inherited)
      const primaryPositions = new Set(primarySignals.map(bitKey));
      for (const ms of mirrorSignals) {
        if (!primaryPositions.has(bitKey(ms))) {
          signals.push(ms);
        }
      }

      // Inherit mux if not locally defined
      if (!mux && primaryFrame.mux) {
        mux = primaryFrame.mux;
      }

      // Inherit metadata if not using copy
      if (!isCopy) {
        if (length === undefined && primaryFrame.length !== undefined) {
          length = primaryFrame.length;
          lengthInherited = true;
        }
        if (transmitter === undefined && primaryFrame.transmitter !== undefined) {
          transmitter = primaryFrame.transmitter;
          transmitterInherited = true;
        }
        const srcInterval = primaryFrame.tx?.interval ?? primaryFrame.tx?.interval_ms;
        if (interval === undefined && srcInterval !== undefined) {
          interval = srcInterval;
          intervalInherited = true;
        }
      }
    }

    return {
      base: {
        length: length ?? 8,
        transmitter,
        interval,
        notes: value.notes,
        signals,
        mux,
      },
      config: {
        protocol: "can",
        id: key,
        extended,
        fd,
        bus: value.bus,
        copy: copyFrom,
        mirror_of: mirrorOf,
      },
      inherited: {
        length: lengthInherited,
        transmitter: transmitterInherited,
        interval: intervalInherited,
        extended: extendedInherited,
        fd: fdInherited,
      },
    };
  },

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
      obj.tx = { interval_ms: base.interval };
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
