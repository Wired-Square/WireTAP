// ui/src/apps/catalog/views/frameEditUtils.ts

import type { ProtocolConfig, ProtocolType } from "../types";
import type { Catalog, Frame } from "../../../types/catalogModel";
import type { FrameFields } from "../../../types/catalogEdit";
import type { FrameEditFields } from "./FrameEditView";

export function defaultFrameConfig(protocol: ProtocolType): ProtocolConfig {
  switch (protocol) {
    case "can":
      return { protocol, id: "" };
    case "modbus":
      return { protocol, register_type: "holding" };
    case "serial":
      return { protocol, frame_id: "" };
  }
}

export function createDefaultFrameFields(protocol: ProtocolType): FrameEditFields {
  return {
    protocol,
    config: defaultFrameConfig(protocol),
    base: { length: protocol === "can" ? 8 : protocol === "modbus" ? 1 : 0 },
    modbusFrameKey: protocol === "modbus" ? "" : undefined,
  };
}

export function frameDefaultInterval(catalog: Catalog | null, protocol: ProtocolType): number | undefined {
  return protocol === "can" ? catalog?.can?.defaultInterval : protocol === "modbus" ? catalog?.modbus?.defaultInterval : undefined;
}

/** The form for an existing frame, every value as the model resolves it. */
export function frameEditFieldsFor(frame: Frame, catalog: Catalog | null): FrameEditFields {
  const { protocol } = frame;
  const base = {
    length: protocol === "modbus" ? frame.modbusRegisterCount ?? 1 : frame.length,
    transmitter: frame.transmitter,
    interval: frame.interval,
    notes: frame.notes,
  };
  const isIntervalInherited =
    !!frame.inheritedFields?.includes("interval") && frameDefaultInterval(catalog, protocol) !== undefined;
  switch (protocol) {
    case "can":
      return {
        protocol,
        base,
        isIntervalInherited,
        config: {
          protocol,
          id: frame.key,
          extended: frame.isExtended,
          fd: frame.isFd,
          bus: frame.bus,
          copy: frame.copyFrom,
          mirror_of: frame.mirrorOf,
        },
      };
    case "modbus":
      return {
        protocol,
        base,
        isIntervalInherited,
        modbusFrameKey: frame.key,
        config: {
          protocol,
          register_number: frame.frameId,
          node_address: ownNodeAddress(frame, catalog),
          register_type: frame.modbusRegisterType ?? "holding",
        },
      };
    case "serial":
      return { protocol, base, isIntervalInherited, config: { protocol, frame_id: frame.key, delimiter: frame.delimiter } };
  }
}

/** The model resolves a register's slave without saying whether the frame names
 *  one; an address the legacy fallback would not give must be the frame's own. */
function ownNodeAddress(frame: Frame, catalog: Catalog | null): number | undefined {
  const fallback = catalog?.modbus?.deviceAddress ?? 1;
  return frame.modbusNode || frame.modbusDeviceAddress !== fallback ? frame.modbusDeviceAddress : undefined;
}

export function frameKeyOf(fields: FrameEditFields): string {
  const { config } = fields;
  switch (config.protocol) {
    case "can":
      return config.id.trim();
    case "modbus":
      return fields.modbusFrameKey?.trim() ?? "";
    case "serial":
      return config.frame_id?.trim() ?? "";
  }
}

/** What the form asks the frame to say; the crate decides what is written. */
export function frameFieldsOf(fields: FrameEditFields): FrameFields {
  const { base, config } = fields;
  const common: FrameFields = {
    length: base.length,
    transmitter: base.transmitter,
    interval_ms: fields.isIntervalInherited ? undefined : base.interval,
    notes: base.notes,
  };
  switch (config.protocol) {
    case "can":
      return { ...common, extended: config.extended, fd: config.fd, bus: config.bus, copy: config.copy, mirror_of: config.mirror_of };
    case "modbus":
      return { ...common, register_number: config.register_number, node_address: config.node_address, register_type: config.register_type };
    case "serial":
      return { ...common, delimiter: config.delimiter };
  }
}

export function isFrameFieldsValid(fields: FrameEditFields): boolean {
  return frameKeyOf(fields) !== "";
}
