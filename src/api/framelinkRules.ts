// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// FrameLink rule operations — WS command wrappers.
// All operations identify the device by device_id. The backend connection
// pool resolves device_id → host:port.

import { wsTransport } from "../services/wsTransport";

// ============================================================================
// Types
// ============================================================================

export interface SignalDefDescriptor {
  signal_id: number;
  name: string;
  start_bit: number;
  bit_length: number;
  byte_order: number;
  value_type: number;
  scale: number;
  offset: number;
}

export interface FrameDefDescriptor {
  frame_def_id: number;
  name: string;
  interface_type: number;
  interface_type_name: string;
  can_id: number | null;
  dlc: number | null;
  extended: boolean | null;
  signals: SignalDefDescriptor[];
}

export interface BridgeFilterDescriptor {
  can_id: number;
  mask: number;
}

export interface BridgeDescriptor {
  bridge_id: number;
  source_interface: number;
  dest_interface: number;
  interface_type: number;
  source_interface_name: string;
  dest_interface_name: string;
  interface_type_name: string;
  enabled: boolean;
  filters: BridgeFilterDescriptor[];
}

export interface SignalMappingDescriptor {
  source_signal_id: number;
  dest_signal_id: number;
  transform_type: string;
  scale?: number;
  offset?: number;
  mask?: number;
}

export interface TransformerDescriptor {
  transformer_id: number;
  source_frame_def_id: number;
  source_frame_def_name: string;
  source_interface: number;
  source_interface_name: string;
  dest_frame_def_id: number;
  dest_frame_def_name: string;
  dest_interface: number;
  dest_interface_name: string;
  enabled: boolean;
  mappings: SignalMappingDescriptor[];
}

export interface GeneratorDescriptor {
  generator_id: number;
  frame_def_id: number;
  frame_def_name: string;
  interface_index: number;
  interface_name: string;
  period_ms: number;
  trigger_type: number;
  trigger_type_name: string;
  enabled: boolean;
  mappings: SignalMappingDescriptor[];
}

// ============================================================================
// Probe / connect
// ============================================================================

export interface ProbeResult {
  device_id: string | null;
  board_name: string | null;
  board_revision: string | null;
  interfaces: { index: number; iface_type: number; name: string }[];
}

/** Probe a FrameLink device by host:port. Returns probe result with device_id. */
export function framelinkProbe(
  host: string,
  port: number,
): Promise<ProbeResult> {
  return wsTransport.command("framelink.probe", { host, port });
}

// ============================================================================
// Frame definition operations
// ============================================================================

export function framelinkFrameDefList(
  deviceId: string,
): Promise<FrameDefDescriptor[]> {
  return wsTransport.command("framelink.frame_def.list", { device_id: deviceId });
}

export function framelinkFrameDefAdd(
  deviceId: string,
  frameDef: Record<string, unknown>,
): Promise<void> {
  return wsTransport.command("framelink.frame_def.add", {
    device_id: deviceId,
    frame_def: frameDef,
  });
}

export function framelinkFrameDefRemove(
  deviceId: string,
  frameDefId: number,
): Promise<void> {
  return wsTransport.command("framelink.frame_def.remove", {
    device_id: deviceId,
    frame_def_id: frameDefId,
  });
}

// ============================================================================
// Bridge operations
// ============================================================================

export function framelinkBridgeList(
  deviceId: string,
): Promise<BridgeDescriptor[]> {
  return wsTransport.command("framelink.bridge.list", { device_id: deviceId });
}

export function framelinkBridgeAdd(
  deviceId: string,
  bridge: Record<string, unknown>,
): Promise<void> {
  return wsTransport.command("framelink.bridge.add", {
    device_id: deviceId,
    bridge,
  });
}

export function framelinkBridgeRemove(
  deviceId: string,
  bridgeId: number,
): Promise<void> {
  return wsTransport.command("framelink.bridge.remove", {
    device_id: deviceId,
    bridge_id: bridgeId,
  });
}

export function framelinkBridgeEnable(
  deviceId: string,
  bridgeId: number,
  enabled: boolean,
): Promise<void> {
  return wsTransport.command("framelink.bridge.enable", {
    device_id: deviceId,
    bridge_id: bridgeId,
    enabled,
  });
}

// ============================================================================
// Transformer operations
// ============================================================================

export function framelinkXformList(
  deviceId: string,
): Promise<TransformerDescriptor[]> {
  return wsTransport.command("framelink.xform.list", { device_id: deviceId });
}

export function framelinkXformAdd(
  deviceId: string,
  transformer: Record<string, unknown>,
): Promise<void> {
  return wsTransport.command("framelink.xform.add", {
    device_id: deviceId,
    transformer,
  });
}

export function framelinkXformRemove(
  deviceId: string,
  transformerId: number,
): Promise<void> {
  return wsTransport.command("framelink.xform.remove", {
    device_id: deviceId,
    transformer_id: transformerId,
  });
}

export function framelinkXformEnable(
  deviceId: string,
  transformerId: number,
  enabled: boolean,
): Promise<void> {
  return wsTransport.command("framelink.xform.enable", {
    device_id: deviceId,
    transformer_id: transformerId,
    enabled,
  });
}

// ============================================================================
// Generator operations
// ============================================================================

export function framelinkGenList(
  deviceId: string,
): Promise<GeneratorDescriptor[]> {
  return wsTransport.command("framelink.gen.list", { device_id: deviceId });
}

export function framelinkGenAdd(
  deviceId: string,
  generator: Record<string, unknown>,
): Promise<void> {
  return wsTransport.command("framelink.gen.add", {
    device_id: deviceId,
    generator,
  });
}

export function framelinkGenRemove(
  deviceId: string,
  generatorId: number,
): Promise<void> {
  return wsTransport.command("framelink.gen.remove", {
    device_id: deviceId,
    generator_id: generatorId,
  });
}

export function framelinkGenEnable(
  deviceId: string,
  generatorId: number,
  enabled: boolean,
): Promise<void> {
  return wsTransport.command("framelink.gen.enable", {
    device_id: deviceId,
    generator_id: generatorId,
    enabled,
  });
}

// ============================================================================
// Persistence operations
// ============================================================================

export function framelinkPersistSave(deviceId: string): Promise<void> {
  return wsTransport.command("framelink.persist.save", { device_id: deviceId });
}

export function framelinkPersistLoad(deviceId: string): Promise<void> {
  return wsTransport.command("framelink.persist.load", { device_id: deviceId });
}

export function framelinkPersistClear(deviceId: string): Promise<void> {
  return wsTransport.command("framelink.persist.clear", { device_id: deviceId });
}

// ============================================================================
// User signal operations
// ============================================================================

export function framelinkUserSignalAdd(
  deviceId: string,
  signalId: number,
): Promise<void> {
  return wsTransport.command("framelink.user_signal.add", {
    device_id: deviceId,
    signal_id: signalId,
  });
}

export function framelinkUserSignalRemove(
  deviceId: string,
  signalId: number,
): Promise<void> {
  return wsTransport.command("framelink.user_signal.remove", {
    device_id: deviceId,
    signal_id: signalId,
  });
}

// ============================================================================
// Device signal operations
// ============================================================================

export interface DeviceSignalDescriptor {
  signal_id: number;
  target_type: number;
  target_index: number;
  property_id: number;
  flags: number;
}

export interface SignalReadResult {
  signal_id: number;
  value: number;
  value_len: number;
}

export function framelinkDsigList(
  deviceId: string,
): Promise<DeviceSignalDescriptor[]> {
  return wsTransport.command("framelink.dsig.list", { device_id: deviceId });
}

export function framelinkDsigRead(
  deviceId: string,
  signalId: number,
): Promise<SignalReadResult> {
  return wsTransport.command("framelink.dsig.read", {
    device_id: deviceId,
    signal_id: signalId,
  });
}

export function framelinkDsigWrite(
  deviceId: string,
  signalId: number,
  value: number,
): Promise<void> {
  return wsTransport.command("framelink.dsig.write", {
    device_id: deviceId,
    signal_id: signalId,
    value,
  });
}

// ============================================================================
// Indicators (mirrors framelink::board::DiscoveredLed)
// ============================================================================

/** Mirrors `framelink::board::DiscoveredLed` with `IndicatorState` flattened via serde. */
export interface DiscoveredLed {
  index: number;
  label: string;
  colour_signal_id: number;
  state_signal_id: number;
  blink_period_signal_id: number;
  toggle_signal_id: number;
  interface_index: number | null;
  interface_type: number | null;
  colour: number;
  state: number;
  blink_period: number;
}

export function framelinkIndicatorsList(
  deviceId: string,
): Promise<DiscoveredLed[]> {
  return wsTransport.command("framelink.indicators.list", { device_id: deviceId });
}

export function framelinkIndicatorConfigure(
  deviceId: string,
  params: Record<string, unknown>,
): Promise<void> {
  return wsTransport.command("framelink.indicator.configure", {
    device_id: deviceId,
    ...params,
  });
}

export function framelinkIndicatorRemove(
  deviceId: string,
  ledIndex: number,
  colourSignalId: number,
  stateSignalId: number,
): Promise<void> {
  return wsTransport.command("framelink.indicator.remove", {
    device_id: deviceId,
    led_index: ledIndex,
    colour_signal_id: colourSignalId,
    state_signal_id: stateSignalId,
  });
}

// ============================================================================
// Palettes (mirrors framelink::board::PaletteInfo)
// ============================================================================

/** Mirrors `framelink::board::PaletteInfo`. */
export interface PaletteInfo {
  name: string;
  description: string;
  signal_start: number;
  entries: number[];
}

export function framelinkPalettesList(
  deviceId: string,
): Promise<PaletteInfo[]> {
  return wsTransport.command("framelink.palettes.list", { device_id: deviceId });
}

