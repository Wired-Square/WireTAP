// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// FrameLink rule operations dispatched via WS commands.
// All operations route through the shared connection pool (one TCP connection per device).

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Extension trait to convert any Display error to String for WS command results.
trait IntoStringErr<T> {
    fn str_err(self) -> Result<T, String>;
}

impl<T, E: fmt::Display> IntoStringErr<T> for Result<T, E> {
    fn str_err(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

use framelink::protocol::bridge::{self, BridgeInfo};
use framelink::protocol::dsig;
use framelink::protocol::frame_def::{self, FrameDefInfo};
use framelink::protocol::generator::{self, GeneratorInfo};
use framelink::protocol::persist;
use framelink::protocol::types::*;
use framelink::protocol::xform::{self, SignalMapping, TransformerInfo, TransformParams};

use framelink::board::{
    self as board_mod, ActivityTrigger, BoardDef, DiscoveredLed,
    INDICATOR_XFORM_ID_BASE,
};
use framelink::board::display::{resolve_frame_def_display, resolve_iface_display, resolve_signal_name};
use framelink::board::editable::{EditableBoardDef, EditableSignal};

use super::shared;

// ============================================================================
// Descriptor types (serde-friendly, sent to frontend)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameDefDescriptor {
    pub frame_def_id: u16,
    pub name: String,
    pub description: Option<String>,
    pub interface_type: u8,
    pub interface_type_name: String,
    pub can_id: Option<u32>,
    pub dlc: Option<u8>,
    pub extended: Option<bool>,
    pub signals: Vec<SignalDefDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalDefDescriptor {
    pub signal_id: u16,
    pub name: String,
    pub start_bit: u16,
    pub bit_length: u16,
    pub byte_order: u8,
    pub value_type: u8,
    pub scale: f32,
    pub offset: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeDescriptor {
    pub bridge_id: u16,
    pub source_interface: u8,
    pub dest_interface: u8,
    pub interface_type: u8,
    pub source_interface_name: String,
    pub dest_interface_name: String,
    pub interface_type_name: String,
    pub enabled: bool,
    pub filters: Vec<BridgeFilterDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeFilterDescriptor {
    pub can_id: u32,
    pub mask: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransformerDescriptor {
    pub transformer_id: u16,
    pub name: String,
    pub description: Option<String>,
    pub source_frame_def_id: u16,
    pub source_frame_def_name: String,
    pub source_interface: u8,
    pub source_interface_name: String,
    pub dest_frame_def_id: u16,
    pub dest_frame_def_name: String,
    pub dest_interface: u8,
    pub dest_interface_name: String,
    pub enabled: bool,
    pub mappings: Vec<SignalMappingDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalMappingDescriptor {
    pub source_signal_id: u16,
    pub dest_signal_id: u16,
    pub transform_type: String,
    pub scale: Option<f32>,
    pub offset: Option<f32>,
    pub mask: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratorDescriptor {
    pub generator_id: u16,
    pub name: String,
    pub description: Option<String>,
    pub frame_def_id: u16,
    pub frame_def_name: String,
    pub interface_index: u8,
    pub interface_name: String,
    pub period_ms: u32,
    pub trigger_type: u8,
    pub trigger_type_name: String,
    pub enabled: bool,
    pub mappings: Vec<SignalMappingDescriptor>,
}

// ============================================================================
// Conversion helpers
// ============================================================================

/// Resolve a frame def signal's display name.
/// Checks EditableBoardDef first (has user-edited names), then falls back to BoardDef.
fn resolve_signal_from_editable(
    sig: &framelink::protocol::frame_def::FrameSignalDef,
    frame_def_id: u16,
    editable: Option<&EditableBoardDef>,
    board_def: Option<&BoardDef>,
) -> String {
    if let Some(ed) = editable {
        if let Some(fd) = ed.frame_defs.get(&frame_def_id) {
            let slug = format!("0x{:04X}", sig.signal_id);
            if let Some(es) = fd.signals.iter().find(|s| s.slug == slug) {
                return es.name.clone();
            }
            // Fall back to position match for signals without matching slug
            if let Some(es) = fd.signals.iter().find(|s| s.start_bit == sig.start_bit && s.bit_length == sig.bit_length) {
                return es.name.clone();
            }
        }
    }
    resolve_signal_name(sig.signal_id, frame_def_id, sig.start_bit, sig.bit_length, board_def)
}

fn frame_def_to_descriptor(
    info: &FrameDefInfo,
    board_def: Option<&BoardDef>,
    editable: Option<&EditableBoardDef>,
) -> FrameDefDescriptor {
    let (can_id, dlc, extended) = match &info.header {
        framelink::protocol::frame_def::FrameHeader::Can { can_id, dlc, flags } => {
            (Some(*can_id), Some(*dlc), Some((*flags & 1) != 0))
        }
        framelink::protocol::frame_def::FrameHeader::Rs485 { .. } => (None, None, None),
    };

    let (name, description) = if let Some(ed) = editable {
        (
            ed.resolve_frame_def_name(info.frame_def_id),
            ed.resolve_frame_def_description(info.frame_def_id),
        )
    } else {
        (resolve_frame_def_display(info.frame_def_id, board_def), None)
    };

    FrameDefDescriptor {
        frame_def_id: info.frame_def_id,
        name,
        description,
        interface_type: info.interface_type,
        interface_type_name: interface_name(info.interface_type).to_string(),
        can_id,
        dlc,
        extended,
        signals: info
            .signals
            .iter()
            .map(|s| SignalDefDescriptor {
                signal_id: s.signal_id,
                name: resolve_signal_from_editable(
                    s, info.frame_def_id, editable, board_def,
                ),
                start_bit: s.start_bit,
                bit_length: s.bit_length,
                byte_order: s.byte_order,
                value_type: s.value_type,
                scale: s.scale,
                offset: s.offset,
            })
            .collect(),
    }
}

fn bridge_to_descriptor(info: &BridgeInfo, board_def: Option<&BoardDef>) -> BridgeDescriptor {
    BridgeDescriptor {
        bridge_id: info.bridge_id,
        source_interface: info.source_interface,
        dest_interface: info.dest_interface,
        interface_type: info.interface_type,
        source_interface_name: resolve_iface_display(info.source_interface, board_def, None),
        dest_interface_name: resolve_iface_display(info.dest_interface, board_def, None),
        interface_type_name: interface_name(info.interface_type).to_string(),
        enabled: info.enabled,
        filters: info
            .filters
            .iter()
            .map(|f| BridgeFilterDescriptor {
                can_id: f.can_id,
                mask: f.mask,
            })
            .collect(),
    }
}

fn mapping_to_descriptor(m: &SignalMapping) -> SignalMappingDescriptor {
    let (transform_type, scale, offset, mask) = match &m.transform {
        TransformParams::Direct => ("direct".to_string(), None, None, None),
        TransformParams::Scale { scale: s, offset: o } => {
            ("scale".to_string(), Some(*s), Some(*o), None)
        }
        TransformParams::Invert => ("invert".to_string(), None, None, None),
        TransformParams::Mask { mask: m } => ("mask".to_string(), None, None, Some(*m)),
    };
    SignalMappingDescriptor {
        source_signal_id: m.source_signal_id,
        dest_signal_id: m.dest_signal_id,
        transform_type,
        scale,
        offset,
        mask,
    }
}

fn xform_to_descriptor(
    info: &TransformerInfo,
    board_def: Option<&BoardDef>,
    editable: Option<&EditableBoardDef>,
) -> TransformerDescriptor {
    let (src_name, dst_name) = if let Some(ed) = editable {
        (
            ed.resolve_frame_def_name(info.source_frame_def_id),
            ed.resolve_frame_def_name(info.dest_frame_def_id),
        )
    } else {
        (
            resolve_frame_def_display(info.source_frame_def_id, board_def),
            resolve_frame_def_display(info.dest_frame_def_id, board_def),
        )
    };
    let name = editable
        .map(|ed| ed.resolve_transformer_name(info.transformer_id))
        .unwrap_or_else(|| format!("Transformer 0x{:04X}", info.transformer_id));
    let description = editable.and_then(|ed| ed.resolve_transformer_description(info.transformer_id));

    TransformerDescriptor {
        transformer_id: info.transformer_id,
        name,
        description,
        source_frame_def_id: info.source_frame_def_id,
        source_frame_def_name: src_name,
        source_interface: info.source_interface,
        source_interface_name: resolve_iface_display(info.source_interface, board_def, None),
        dest_frame_def_id: info.dest_frame_def_id,
        dest_frame_def_name: dst_name,
        dest_interface: info.dest_interface,
        dest_interface_name: resolve_iface_display(info.dest_interface, board_def, None),
        enabled: info.enabled,
        mappings: info.mappings.iter().map(mapping_to_descriptor).collect(),
    }
}

fn gen_to_descriptor(
    info: &GeneratorInfo,
    board_def: Option<&BoardDef>,
    editable: Option<&EditableBoardDef>,
) -> GeneratorDescriptor {
    let trigger_type_name = generator::trigger_type_name(info.trigger_type)
        .to_lowercase()
        .replace(' ', "_");

    let frame_def_name = if let Some(ed) = editable {
        ed.resolve_frame_def_name(info.frame_def_id)
    } else {
        resolve_frame_def_display(info.frame_def_id, board_def)
    };
    let name = editable
        .map(|ed| ed.resolve_generator_name(info.generator_id))
        .unwrap_or_else(|| format!("Generator 0x{:04X}", info.generator_id));
    let description = editable.and_then(|ed| ed.resolve_generator_description(info.generator_id));

    GeneratorDescriptor {
        generator_id: info.generator_id,
        name,
        description,
        frame_def_id: info.frame_def_id,
        frame_def_name,
        interface_index: info.interface_index,
        interface_name: resolve_iface_display(info.interface_index, board_def, None),
        period_ms: info.period_ms,
        trigger_type: info.trigger_type,
        trigger_type_name,
        enabled: info.enabled,
        mappings: info.mappings.iter().map(mapping_to_descriptor).collect(),
    }
}

// ============================================================================
// Params deserialization helpers
// ============================================================================

/// Extract device_id from command params.
fn get_device_id(params: &Value) -> Result<String, String> {
    params["device_id"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Missing 'device_id' parameter".to_string())
}

fn get_timeout(params: &Value) -> f64 {
    params["timeout"].as_f64().unwrap_or(5.0)
}

// ============================================================================
// JSON → protocol struct parsers
// ============================================================================

fn parse_frame_def_info(v: &Value) -> Result<FrameDefInfo, String> {
    let frame_def_id = v["frame_def_id"].as_u64().ok_or("Missing frame_def_id")? as u16;
    let interface_type = v["interface_type"].as_u64().ok_or("Missing interface_type")? as u8;

    let header = if interface_type == IFACE_RS485 {
        let framing_mode = v["framing_mode"].as_u64().unwrap_or(0) as u8;
        frame_def::FrameHeader::Rs485 { framing_mode }
    } else {
        let can_id = v["can_id"].as_u64().ok_or("Missing can_id")? as u32;
        let dlc = v["dlc"].as_u64().ok_or("Missing dlc")? as u8;
        let extended = v["extended"].as_bool().unwrap_or(false);
        frame_def::FrameHeader::Can {
            can_id,
            dlc,
            flags: if extended { 1 } else { 0 },
        }
    };

    let signals = v["signals"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    Some(frame_def::FrameSignalDef {
                        signal_id: s["signal_id"].as_u64()? as u16,
                        start_bit: s["start_bit"].as_u64()? as u16,
                        bit_length: s["bit_length"].as_u64()? as u16,
                        byte_order: s["byte_order"].as_u64().unwrap_or(0) as u8,
                        value_type: s["value_type"].as_u64().unwrap_or(0) as u8,
                        scale: s["scale"].as_f64().unwrap_or(1.0) as f32,
                        offset: s["offset"].as_f64().unwrap_or(0.0) as f32,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(FrameDefInfo {
        frame_def_id,
        interface_type,
        header,
        signals,
    })
}

fn parse_bridge_info(v: &Value) -> Result<BridgeInfo, String> {
    Ok(BridgeInfo {
        bridge_id: v["bridge_id"].as_u64().ok_or("Missing bridge_id")? as u16,
        source_interface: v["source_interface"].as_u64().ok_or("Missing source_interface")? as u8,
        dest_interface: v["dest_interface"].as_u64().ok_or("Missing dest_interface")? as u8,
        interface_type: v["interface_type"].as_u64().ok_or("Missing interface_type")? as u8,
        enabled: v["enabled"].as_bool().unwrap_or(true),
        filters: v["filters"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|f| {
                        Some(bridge::BridgeFilter {
                            can_id: f["can_id"].as_u64()? as u32,
                            mask: f["mask"].as_u64().unwrap_or(0xFFFFFFFF) as u32,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn parse_signal_mapping(v: &Value) -> Option<SignalMapping> {
    let source_signal_id = v["source_signal_id"].as_u64()? as u16;
    let dest_signal_id = v["dest_signal_id"].as_u64()? as u16;
    let transform = match v["transform_type"].as_str().unwrap_or("direct") {
        "scale" => TransformParams::Scale {
            scale: v["scale"].as_f64().unwrap_or(1.0) as f32,
            offset: v["offset"].as_f64().unwrap_or(0.0) as f32,
        },
        "invert" => TransformParams::Invert,
        "mask" => TransformParams::Mask {
            mask: v["mask"].as_u64().unwrap_or(0xFFFFFFFF) as u32,
        },
        _ => TransformParams::Direct,
    };
    Some(SignalMapping {
        source_signal_id,
        dest_signal_id,
        transform,
    })
}

fn parse_transformer_info(v: &Value) -> Result<TransformerInfo, String> {
    Ok(TransformerInfo {
        transformer_id: v["transformer_id"]
            .as_u64()
            .ok_or("Missing transformer_id")? as u16,
        source_frame_def_id: v["source_frame_def_id"]
            .as_u64()
            .ok_or("Missing source_frame_def_id")? as u16,
        source_interface: v["source_interface"]
            .as_u64()
            .ok_or("Missing source_interface")? as u8,
        dest_frame_def_id: v["dest_frame_def_id"]
            .as_u64()
            .ok_or("Missing dest_frame_def_id")? as u16,
        dest_interface: v["dest_interface"]
            .as_u64()
            .ok_or("Missing dest_interface")? as u8,
        enabled: v["enabled"].as_bool().unwrap_or(true),
        mappings: v["mappings"]
            .as_array()
            .map(|arr| arr.iter().filter_map(parse_signal_mapping).collect())
            .unwrap_or_default(),
        functions: vec![],
    })
}

fn parse_generator_info(v: &Value) -> Result<GeneratorInfo, String> {
    Ok(GeneratorInfo {
        generator_id: v["generator_id"]
            .as_u64()
            .ok_or("Missing generator_id")? as u16,
        frame_def_id: v["frame_def_id"]
            .as_u64()
            .ok_or("Missing frame_def_id")? as u16,
        interface_index: v["interface_index"]
            .as_u64()
            .ok_or("Missing interface_index")? as u8,
        period_ms: v["period_ms"].as_u64().ok_or("Missing period_ms")? as u32,
        trigger_type: v["trigger_type"].as_u64().unwrap_or(0) as u8,
        enabled: v["enabled"].as_bool().unwrap_or(true),
        mappings: v["mappings"]
            .as_array()
            .map(|arr| arr.iter().filter_map(parse_signal_mapping).collect())
            .unwrap_or_default(),
    })
}

// ============================================================================
// Command dispatcher
// ============================================================================

pub async fn dispatch_framelink_command(
    op_name: &str,
    params: Value,
) -> Result<Value, String> {
    match op_name {
        // Probe / connect
        "framelink.probe" => cmd_probe(params).await,

        // Frame definitions
        "framelink.frame_def.list" => cmd_frame_def_list(params).await,
        "framelink.frame_def.add" => cmd_frame_def_add(params).await,
        "framelink.frame_def.remove" => cmd_frame_def_remove(params).await,

        // Bridges
        "framelink.bridge.list" => cmd_bridge_list(params).await,
        "framelink.bridge.add" => cmd_bridge_add(params).await,
        "framelink.bridge.remove" => cmd_bridge_remove(params).await,
        "framelink.bridge.enable" => cmd_bridge_enable(params).await,

        // Transformers
        "framelink.xform.list" => cmd_xform_list(params).await,
        "framelink.xform.add" => cmd_xform_add(params).await,
        "framelink.xform.remove" => cmd_xform_remove(params).await,
        "framelink.xform.enable" => cmd_xform_enable(params).await,

        // Generators
        "framelink.gen.list" => cmd_gen_list(params).await,
        "framelink.gen.add" => cmd_gen_add(params).await,
        "framelink.gen.remove" => cmd_gen_remove(params).await,
        "framelink.gen.enable" => cmd_gen_enable(params).await,

        // Persistence
        "framelink.persist.save" => cmd_persist_save(params).await,
        "framelink.persist.load" => cmd_persist_load(params).await,
        "framelink.persist.clear" => cmd_persist_clear(params).await,

        // User signals
        "framelink.user_signal.add" => cmd_user_signal_add(params).await,
        "framelink.user_signal.remove" => cmd_user_signal_remove(params).await,

        // Device signals
        "framelink.dsig.list" => cmd_dsig_list(params).await,
        "framelink.dsig.read" => cmd_dsig_read(params).await,
        "framelink.dsig.write" => cmd_dsig_write(params).await,

        // Indicators (LED discovery via library)
        "framelink.indicators.list" => cmd_indicators_list(params).await,
        "framelink.indicator.configure" => cmd_indicator_configure(params).await,
        "framelink.indicator.remove" => cmd_indicator_remove(params).await,

        // Palettes (from board definition)
        "framelink.palettes.list" => cmd_palettes_list(params).await,

        // Labels (pending name/description edits)
        "framelink.label.set" => cmd_label_set(params).await,
        "framelink.label.remove" => cmd_label_remove(params).await,

        // Selectable signals
        "framelink.signals.selectable" => cmd_signals_selectable(params).await,

        _ => Err(format!("Unknown framelink command: {op_name}")),
    }
}

// ============================================================================
// Probe
// ============================================================================

async fn cmd_probe(params: Value) -> Result<Value, String> {
    let host = params["host"]
        .as_str()
        .ok_or("Missing 'host' parameter")?;
    let port = params["port"]
        .as_u64()
        .ok_or("Missing 'port' parameter")? as u16;
    let timeout = get_timeout(&params);
    let result = super::probe_framelink(host, port, timeout).await?;
    serde_json::to_value(&result).map_err(|e| e.to_string())
}

// ============================================================================
// Frame definition operations
// ============================================================================

async fn cmd_frame_def_list(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let board_def = shared::load_board_def(&device_id).await;
    let editable = shared::clone_editable_board_def(&device_id).await;
    let payload = frame_def::build_frame_def_list();
    let frames =
        conn.session.request_multi(MSG_FRAME_DEF_LIST, FLAG_ACK_REQ, &payload).await.str_err()?;

    let descriptors: Vec<FrameDefDescriptor> = frames
        .iter()
        .filter_map(|f| frame_def::parse_frame_def_resp(&f.payload).ok())
        .map(|info| frame_def_to_descriptor(&info, board_def.as_ref(), editable.as_ref()))
        .collect();

    serde_json::to_value(&descriptors).map_err(|e| e.to_string())
}

async fn cmd_frame_def_add(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let fd = &params["frame_def"];
    let info = parse_frame_def_info(fd)?;
    let payload = frame_def::build_frame_def_add(&info);
    conn.session.request(MSG_FRAME_DEF_ADD, FLAG_ACK_REQ, &payload).await.str_err()?;

    // Sync signal display names from the UI into the EditableBoardDef.
    // The protocol doesn't carry signal names — they're TOML-only metadata.
    let signal_names: Vec<(u16, String)> = fd["signals"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let id = s["signal_id"].as_u64()? as u16;
                    let name = s["name"].as_str()?.to_string();
                    Some((id, name))
                })
                .collect()
        })
        .unwrap_or_default();

    if !signal_names.is_empty() {
        use framelink::board::editable::EditableFrameSignal;

        let frame_def_id = info.frame_def_id;
        let signals_from_ui: Vec<EditableFrameSignal> = info.signals.iter().zip(signal_names.iter())
            .map(|(proto_sig, (_sig_id, name))| {
                let byte_order = if proto_sig.byte_order == 0 { "le" } else { "be" };
                let value_type = if proto_sig.value_type == 0 { "unsigned" } else { "signed" };
                EditableFrameSignal {
                    slug: format!("0x{:04X}", proto_sig.signal_id),
                    name: name.clone(),
                    start_bit: proto_sig.start_bit,
                    bit_length: proto_sig.bit_length,
                    byte_order: byte_order.to_string(),
                    value_type: value_type.to_string(),
                    scale: proto_sig.scale,
                    offset: proto_sig.offset,
                    unit: String::new(),
                }
            })
            .collect();

        let _ = shared::with_editable_board_def(&device_id, timeout, |ed| {
            if let Some(fd_entry) = ed.frame_defs.get_mut(&frame_def_id) {
                fd_entry.signals = signals_from_ui;
            }
        })
        .await;
    }

    Ok(Value::Null)
}

async fn cmd_frame_def_remove(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let frame_def_id = params["frame_def_id"]
        .as_u64()
        .ok_or("Missing 'frame_def_id'")? as u16;
    let payload = frame_def::build_frame_def_remove(frame_def_id);
    conn.session.request(MSG_FRAME_DEF_REMOVE, FLAG_ACK_REQ, &payload).await.str_err()?;
    Ok(Value::Null)
}

// ============================================================================
// Bridge operations
// ============================================================================

async fn cmd_bridge_list(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let board_def = shared::load_board_def(&device_id).await;
    let payload = bridge::build_bridge_list();
    let frames =
        conn.session.request_multi(MSG_BRIDGE_LIST, FLAG_ACK_REQ, &payload).await.str_err()?;

    let descriptors: Vec<BridgeDescriptor> = frames
        .iter()
        .filter_map(|f| bridge::parse_bridge_resp(&f.payload).ok())
        .map(|info| bridge_to_descriptor(&info, board_def.as_ref()))
        .collect();

    serde_json::to_value(&descriptors).map_err(|e| e.to_string())
}

async fn cmd_bridge_add(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let b = &params["bridge"];
    let info = parse_bridge_info(b)?;
    let payload = bridge::build_bridge_add(&info);
    conn.session.request(MSG_BRIDGE_ADD, FLAG_ACK_REQ, &payload).await.str_err()?;
    Ok(Value::Null)
}

async fn cmd_bridge_remove(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let bridge_id = params["bridge_id"]
        .as_u64()
        .ok_or("Missing 'bridge_id'")? as u16;
    let payload = bridge::build_bridge_remove(bridge_id);
    conn.session.request(MSG_BRIDGE_REMOVE, FLAG_ACK_REQ, &payload).await.str_err()?;
    Ok(Value::Null)
}

async fn cmd_bridge_enable(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let bridge_id = params["bridge_id"]
        .as_u64()
        .ok_or("Missing 'bridge_id'")? as u16;
    let enabled = params["enabled"]
        .as_bool()
        .ok_or("Missing 'enabled'")?;
    let payload = bridge::build_bridge_enable(bridge_id, enabled);
    conn.session.request(MSG_BRIDGE_ENABLE, FLAG_ACK_REQ, &payload).await.str_err()?;
    Ok(Value::Null)
}

// ============================================================================
// Transformer operations
// ============================================================================

async fn cmd_xform_list(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let board_def = shared::load_board_def(&device_id).await;
    let editable = shared::clone_editable_board_def(&device_id).await;
    let payload = xform::build_xform_list();
    let frames =
        conn.session.request_multi(MSG_XFORM_LIST, FLAG_ACK_REQ, &payload).await.str_err()?;

    let descriptors: Vec<TransformerDescriptor> = frames
        .iter()
        .filter_map(|f| xform::parse_xform_resp(&f.payload).ok())
        .map(|info| xform_to_descriptor(&info, board_def.as_ref(), editable.as_ref()))
        .collect();

    serde_json::to_value(&descriptors).map_err(|e| e.to_string())
}

async fn cmd_xform_add(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let t = &params["transformer"];
    let info = parse_transformer_info(t)?;
    let payload = xform::build_xform_add(&info);
    conn.session.request(MSG_XFORM_ADD, FLAG_ACK_REQ, &payload).await.str_err()?;
    Ok(Value::Null)
}

async fn cmd_xform_remove(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let transformer_id = params["transformer_id"]
        .as_u64()
        .ok_or("Missing 'transformer_id'")? as u16;
    let payload = xform::build_xform_remove(transformer_id);
    conn.session.request(MSG_XFORM_REMOVE, FLAG_ACK_REQ, &payload).await.str_err()?;
    Ok(Value::Null)
}

async fn cmd_xform_enable(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let transformer_id = params["transformer_id"]
        .as_u64()
        .ok_or("Missing 'transformer_id'")? as u16;
    let enabled = params["enabled"]
        .as_bool()
        .ok_or("Missing 'enabled'")?;
    let payload = xform::build_xform_enable(transformer_id, enabled);
    conn.session.request(MSG_XFORM_ENABLE, FLAG_ACK_REQ, &payload).await.str_err()?;
    Ok(Value::Null)
}

// ============================================================================
// Generator operations
// ============================================================================

async fn cmd_gen_list(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let board_def = shared::load_board_def(&device_id).await;
    let editable = shared::clone_editable_board_def(&device_id).await;
    let payload = generator::build_gen_list();
    let frames =
        conn.session.request_multi(MSG_GEN_LIST, FLAG_ACK_REQ, &payload).await.str_err()?;

    let descriptors: Vec<GeneratorDescriptor> = frames
        .iter()
        .filter_map(|f| generator::parse_gen_resp(&f.payload).ok())
        .map(|info| gen_to_descriptor(&info, board_def.as_ref(), editable.as_ref()))
        .collect();

    serde_json::to_value(&descriptors).map_err(|e| e.to_string())
}

async fn cmd_gen_add(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let g = &params["generator"];
    let info = parse_generator_info(g)?;
    let payload = generator::build_gen_add(&info);
    conn.session.request(MSG_GEN_ADD, FLAG_ACK_REQ, &payload).await.str_err()?;
    Ok(Value::Null)
}

async fn cmd_gen_remove(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let generator_id = params["generator_id"]
        .as_u64()
        .ok_or("Missing 'generator_id'")? as u16;
    let payload = generator::build_gen_remove(generator_id);
    conn.session.request(MSG_GEN_REMOVE, FLAG_ACK_REQ, &payload).await.str_err()?;
    Ok(Value::Null)
}

async fn cmd_gen_enable(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let generator_id = params["generator_id"]
        .as_u64()
        .ok_or("Missing 'generator_id'")? as u16;
    let enabled = params["enabled"]
        .as_bool()
        .ok_or("Missing 'enabled'")?;
    let payload = generator::build_gen_enable(generator_id, enabled);
    conn.session.request(MSG_GEN_ENABLE, FLAG_ACK_REQ, &payload).await.str_err()?;
    Ok(Value::Null)
}

// ============================================================================
// Persistence operations
// ============================================================================

async fn cmd_persist_save(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;

    // Step 1: Send MSG_PERSIST_SAVE — if this fails, stop immediately
    let payload = persist::build_persist_save();
    conn.session.request(MSG_PERSIST_SAVE, FLAG_ACK_REQ, &payload).await.str_err()?;

    // Step 2: Collect active rule IDs from the device
    let active = conn.session.collect_active_rule_ids().await.str_err()?;

    // Step 3: Build merged TOML from a cloned EditableBoardDef
    let merged_toml = {
        let editable = shared::clone_editable_board_def(&device_id).await;
        match editable {
            Some(mut ed) => {
                ed.merge_pending(&active);
                Some(ed.to_toml())
            }
            None => None,
        }
    };

    // Step 4: Upload merged TOML to device
    if let Some(ref toml_str) = merged_toml {
        let conn = shared::get_connection(&device_id, timeout).await?;
        framelink::board::transfer::upload_board_def(&conn.session, toml_str).await?;
    }

    // Step 5: Merge pending on the real EditableBoardDef (clearing pending state)
    let _ = shared::with_editable_board_def(&device_id, timeout, |ed| {
        ed.merge_pending(&active);
    })
    .await;

    Ok(Value::Null)
}


async fn cmd_persist_load(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let payload = persist::build_persist_load();
    conn.session.request(MSG_PERSIST_LOAD, FLAG_ACK_REQ, &payload).await.str_err()?;
    Ok(Value::Null)
}

async fn cmd_persist_clear(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let payload = persist::build_persist_clear();
    conn.session.request(MSG_PERSIST_CLEAR, FLAG_ACK_REQ, &payload).await.str_err()?;
    Ok(Value::Null)
}

// ============================================================================
// User signal operations
// ============================================================================

async fn cmd_user_signal_add(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let signal_id = params["signal_id"]
        .as_u64()
        .ok_or("Missing 'signal_id'")? as u16;
    let payload = dsig::build_user_signal_add(signal_id);
    conn.session.request(MSG_USER_SIGNAL_ADD, FLAG_ACK_REQ, &payload).await.str_err()?;

    // Insert signal metadata into the editable board definition
    let name = params["name"]
        .as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("User Signal 0x{:04X}", signal_id));
    let group = params["group"]
        .as_str()
        .unwrap_or("User")
        .to_string();
    let format_str = params["format"]
        .as_str()
        .unwrap_or("number")
        .to_string();
    let unit = params["unit"]
        .as_str()
        .unwrap_or("")
        .to_string();
    let enum_values: BTreeMap<u32, String> = params["enum_values"]
        .as_object()
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| {
                    let key = k.parse::<u32>().ok()?;
                    let val = v.as_str()?.to_string();
                    Some((key, val))
                })
                .collect()
        })
        .unwrap_or_default();

    shared::with_editable_board_def(&device_id, timeout, |board_def| {
        board_def.signals.insert(signal_id, EditableSignal {
            name,
            group,
            unit,
            format: format_str,
            enum_values,
            description: String::new(),
        });
        board_def.dirty = true;
    })
    .await?;

    shared::upload_board_def(&device_id, timeout).await?;

    Ok(Value::Null)
}

async fn cmd_user_signal_remove(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let signal_id = params["signal_id"]
        .as_u64()
        .ok_or("Missing 'signal_id'")? as u16;
    let payload = dsig::build_user_signal_remove(signal_id);
    conn.session.request(MSG_USER_SIGNAL_REMOVE, FLAG_ACK_REQ, &payload).await.str_err()?;

    // Remove the signal metadata from the editable board definition
    let removed = shared::with_editable_board_def(&device_id, timeout, |board_def| {
        let existed = board_def.signals.remove(&signal_id).is_some();
        if existed {
            board_def.dirty = true;
        }
        existed
    })
    .await?;

    if removed {
        shared::upload_board_def(&device_id, timeout).await?;
    }

    Ok(Value::Null)
}

// ============================================================================
// Device signal operations
// ============================================================================

#[derive(Debug, Serialize)]
struct DeviceSignalDescriptor {
    signal_id: u16,
    target_type: u8,
    target_index: u8,
    property_id: u8,
    flags: u8,
}


async fn cmd_dsig_list(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let signals = conn.session.list_all_signals().await.str_err()?;
    let descriptors: Vec<DeviceSignalDescriptor> = signals
        .iter()
        .map(|s| DeviceSignalDescriptor {
            signal_id: s.signal_id,
            target_type: s.target_type,
            target_index: s.target_index,
            property_id: s.property_id,
            flags: s.flags,
        })
        .collect();
    serde_json::to_value(&descriptors).map_err(|e| e.to_string())
}

async fn cmd_dsig_read(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let signal_id = params["signal_id"]
        .as_u64()
        .ok_or("Missing 'signal_id'")? as u16;
    let payload = dsig::build_read_request(signal_id);
    let frame = conn.session.request(MSG_DSIG_READ, FLAG_ACK_REQ, &payload).await.str_err()?;
    let sv = dsig::parse_read_response(&frame.payload)
        .map_err(|e| format!("Failed to parse signal read: {e}"))?;
    serde_json::to_value(&serde_json::json!({
        "signal_id": sv.signal_id,
        "value": sv.value,
        "value_len": sv.value_len,
    }))
    .map_err(|e| e.to_string())
}

async fn cmd_dsig_write(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let signal_id = params["signal_id"]
        .as_u64()
        .ok_or("Missing 'signal_id'")? as u16;
    let value = params["value"]
        .as_u64()
        .or_else(|| params["value"].as_i64().map(|v| v as u64))
        .ok_or("Missing 'value'")?;

    let write_payload = dsig::build_write_request(signal_id, value);
    conn.session.request(MSG_DSIG_WRITE, FLAG_ACK_REQ, &write_payload).await.str_err()?;
    Ok(Value::Null)
}

// ============================================================================
// Indicator discovery (delegates to framelink::board::discover_leds)
// ============================================================================

async fn cmd_indicators_list(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;

    // List device signals
    let all_signals = conn.session.list_all_signals().await.str_err()?;

    // Load board def for label enrichment
    let board_def = shared::load_board_def(&device_id).await;

    // Discover LEDs using the library function
    let mut indicators = framelink::board::discover_leds(&all_signals, board_def.as_ref());

    // Build batch of signal reads — all sent pipelined, matching the TUI pattern
    let mut read_messages: Vec<(u8, u8, Vec<u8>)> = Vec::new();
    // Track which indicator and field each read corresponds to
    let mut read_map: Vec<(usize, &str)> = Vec::new(); // (indicator index, "colour"/"state"/"blink")

    for (i, led) in indicators.iter().enumerate() {
        if led.index == 0 {
            continue;
        }
        read_messages.push((MSG_DSIG_READ, FLAG_ACK_REQ, dsig::build_read_request(led.colour_signal_id)));
        read_map.push((i, "colour"));

        if led.state_signal_id != 0 {
            read_messages.push((MSG_DSIG_READ, FLAG_ACK_REQ, dsig::build_read_request(led.state_signal_id)));
            read_map.push((i, "state"));
        }
        if led.blink_period_signal_id != 0 {
            read_messages.push((MSG_DSIG_READ, FLAG_ACK_REQ, dsig::build_read_request(led.blink_period_signal_id)));
            read_map.push((i, "blink"));
        }
    }

    if !read_messages.is_empty() {
        let responses = conn.session.send_batch(&read_messages).await.str_err()?;
        for (resp, (idx, field)) in responses.iter().zip(read_map.iter()) {
            if let Ok(sv) = dsig::parse_read_response(&resp.payload) {
                match *field {
                    "colour" => indicators[*idx].state.colour = sv.value as u32,
                    "state" => indicators[*idx].state.state = sv.value as u8,
                    "blink" => indicators[*idx].state.blink_period = sv.value as u16,
                    _ => {}
                }
            }
        }
    }

    // Filter out Status LED (index 0) before returning
    indicators.retain(|led| led.index != 0);
    serde_json::to_value(&indicators).map_err(|e| e.to_string())
}

// ============================================================================
// Palette list (from board definition)
// ============================================================================

async fn cmd_palettes_list(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;

    let board_def = shared::load_board_def(&device_id)
        .await
        .ok_or("No board definition available")?;

    serde_json::to_value(&board_def.palettes).map_err(|e| e.to_string())
}

// ============================================================================
// Indicator configuration
// ============================================================================

/// Build the common messages for palette/threshold indicator setup:
/// remove old trigger, add transformer with primary function + optional gate, turn LED on.
fn build_indicator_xform_messages(
    messages: &mut Vec<(u8, u8, Vec<u8>)>,
    led: &DiscoveredLed,
    source_frame_def_id: u16,
    primary_function: xform::XformFunction,
    gate_signal_id: Option<u16>,
) {
    // Remove old trigger
    for (mt, pl) in board_mod::build_indicator_trigger_remove_messages(led.index) {
        messages.push((mt, FLAG_ACK_REQ, pl));
    }

    let xform_id = INDICATOR_XFORM_ID_BASE + led.index as u16;
    let mut functions = vec![primary_function];
    if let Some(guard_id) = gate_signal_id {
        functions.push(xform::XformFunction {
            function_id: xform::FUNC_GATE,
            source_signal_id: led.colour_signal_id,
            dest_signal_id: led.colour_signal_id,
            params: xform::FunctionParams::Gate {
                guard_signal_id: guard_id,
                compare_op: xform::GateOp::NotEqual,
                compare_value: 0,
                fail_value: 0,
            },
        });
    }
    let xform_info = xform::TransformerInfo {
        transformer_id: xform_id,
        source_frame_def_id,
        source_interface: 0xFF,
        dest_frame_def_id: FRAME_DEF_ID_DEVICE,
        dest_interface: 0xFF,
        enabled: true,
        mappings: vec![],
        functions,
    };
    messages.push((MSG_XFORM_ADD, FLAG_ACK_REQ, xform::build_xform_add(&xform_info)));
    messages.push((MSG_DSIG_WRITE, FLAG_ACK_REQ, dsig::build_write_request(led.state_signal_id, 1)));
}

async fn cmd_indicator_configure(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;

    let source = params["source"].as_str().ok_or("Missing 'source'")?;

    // Parse the DiscoveredLed from params (signal IDs + index needed for trigger building)
    let led: DiscoveredLed =
        serde_json::from_value(params["led"].clone()).map_err(|e| format!("Invalid led: {e}"))?;

    let mut messages: Vec<(u8, u8, Vec<u8>)> = Vec::new();

    match source {
        "activity" => {
            let trigger: ActivityTrigger = serde_json::from_value(params["trigger"].clone())
                .map_err(|e| format!("Invalid trigger: {e}"))?;
            let colour = params["colour"].as_u64().unwrap_or(0xFF00FF00) as u32;

            // Write colour + state=on
            messages.push((MSG_DSIG_WRITE, FLAG_ACK_REQ, dsig::build_write_request(led.colour_signal_id, colour as u64)));
            messages.push((MSG_DSIG_WRITE, FLAG_ACK_REQ, dsig::build_write_request(led.state_signal_id, 1)));

            // Remove old trigger, add new
            for (mt, pl) in board_mod::build_indicator_trigger_remove_messages(led.index) {
                messages.push((mt, FLAG_ACK_REQ, pl));
            }
            for (mt, pl) in board_mod::build_indicator_trigger_messages(&led, &trigger) {
                messages.push((mt, FLAG_ACK_REQ, pl));
            }
        }

        "palette" => {
            let source_frame_def_id = params["source_frame_def_id"].as_u64().ok_or("Missing source_frame_def_id")? as u16;
            let source_signal_id = params["source_signal_id"].as_u64().ok_or("Missing source_signal_id")? as u16;
            let palette_signal_start = params["palette_signal_start"].as_u64().ok_or("Missing palette_signal_start")? as u16;
            let signal_max = params["signal_max"].as_u64().unwrap_or(1000) as u16;
            let gate_signal_id = params["gate_signal_id"].as_u64().map(|v| v as u16);

            // Load palette entries from board def to register user signals and write values
            let board_def = shared::load_board_def(&device_id).await;

            if let Some(ref bd) = board_def {
                if let Some(pal) = bd.palettes.iter().find(|p| p.signal_start == palette_signal_start) {
                    messages.push((MSG_USER_SIGNAL_ADD, FLAG_ACK_REQ, dsig::build_user_signal_add(palette_signal_start)));
                    for i in 0..pal.entries.len() {
                        messages.push((MSG_USER_SIGNAL_ADD, FLAG_ACK_REQ, dsig::build_user_signal_add(palette_signal_start + 1 + i as u16)));
                    }
                    messages.push((MSG_DSIG_WRITE, FLAG_ACK_REQ, dsig::build_write_request(palette_signal_start, pal.entries.len() as u64)));
                    for (i, &colour) in pal.entries.iter().enumerate() {
                        messages.push((MSG_DSIG_WRITE, FLAG_ACK_REQ, dsig::build_write_request(palette_signal_start + 1 + i as u16, colour as u64)));
                    }
                }
            }

            let primary_function = xform::XformFunction {
                function_id: xform::FUNC_PALETTE,
                source_signal_id,
                dest_signal_id: led.colour_signal_id,
                params: xform::FunctionParams::Palette { palette_signal_start, signal_max },
            };
            build_indicator_xform_messages(&mut messages, &led, source_frame_def_id, primary_function, gate_signal_id);
        }

        "threshold" => {
            let source_frame_def_id = params["source_frame_def_id"].as_u64().ok_or("Missing source_frame_def_id")? as u16;
            let source_signal_id = params["source_signal_id"].as_u64().ok_or("Missing source_signal_id")? as u16;
            let threshold = params["threshold"].as_u64().unwrap_or(500) as u32;
            let value_above = params["value_above"].as_u64().unwrap_or(0xFF00FF00) as u32;
            let value_below = params["value_below"].as_u64().unwrap_or(0) as u32;
            let gate_signal_id = params["gate_signal_id"].as_u64().map(|v| v as u16);

            let primary_function = xform::XformFunction {
                function_id: xform::FUNC_THRESHOLD,
                source_signal_id,
                dest_signal_id: led.colour_signal_id,
                params: xform::FunctionParams::Threshold { threshold, value_above, value_below },
            };
            build_indicator_xform_messages(&mut messages, &led, source_frame_def_id, primary_function, gate_signal_id);
        }

        _ => return Err(format!("Unknown indicator source: {source}")),
    }

    // Send all messages as a batch
    conn.session.send_batch(&messages).await.str_err()?;
    Ok(Value::Null)
}

async fn cmd_indicator_remove(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let conn = shared::get_connection(&device_id, timeout).await?;
    let led_index = params["led_index"].as_u64().ok_or("Missing 'led_index'")? as usize;
    let colour_signal_id = params["colour_signal_id"].as_u64().ok_or("Missing 'colour_signal_id'")? as u16;
    let state_signal_id = params["state_signal_id"].as_u64().ok_or("Missing 'state_signal_id'")? as u16;

    let mut messages: Vec<(u8, u8, Vec<u8>)> = Vec::new();

    // Remove trigger (transformer + frame def)
    for (mt, pl) in board_mod::build_indicator_trigger_remove_messages(led_index) {
        messages.push((mt, FLAG_ACK_REQ, pl));
    }

    // Set LED off + default colour
    messages.push((MSG_DSIG_WRITE, FLAG_ACK_REQ, dsig::build_write_request(state_signal_id, 0)));
    messages.push((MSG_DSIG_WRITE, FLAG_ACK_REQ, dsig::build_write_request(colour_signal_id, 0)));

    conn.session.send_batch(&messages).await.str_err()?;
    Ok(Value::Null)
}

// ============================================================================
// Label operations (pending name/description edits)
// ============================================================================

async fn cmd_label_set(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let _conn = shared::get_connection(&device_id, timeout).await?;
    let entity_type = params["entity_type"].as_str().ok_or("Missing entity_type")?;
    let id = params["id"].as_u64().ok_or("Missing id")? as u16;
    let name = params["name"].as_str().map(String::from);
    let description = params["description"].as_str().map(String::from);

    shared::with_editable_board_def(&device_id, timeout, |ed| {
        match entity_type {
            "frame_def" => ed.set_pending_frame_def(id, name, description),
            "generator" => ed.set_pending_generator(id, name, description),
            "transformer" => ed.set_pending_transformer(id, name, description),
            _ => return Err(format!("Unknown entity type: {entity_type}")),
        }
        Ok(())
    })
    .await??;

    Ok(Value::Null)
}

async fn cmd_label_remove(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let _conn = shared::get_connection(&device_id, timeout).await?;
    let entity_type = params["entity_type"].as_str().ok_or("Missing entity_type")?;
    let id = params["id"].as_u64().ok_or("Missing id")? as u16;

    shared::with_editable_board_def(&device_id, timeout, |ed| {
        match entity_type {
            "frame_def" => ed.remove_pending_frame_def(id),
            "generator" => ed.remove_pending_generator(id),
            "transformer" => ed.remove_pending_transformer(id),
            _ => return Err(format!("Unknown entity type: {entity_type}")),
        }
        Ok(())
    })
    .await??;

    Ok(Value::Null)
}

// ============================================================================
// Selectable signals (all signals available for UI selection)
// ============================================================================

async fn cmd_signals_selectable(params: Value) -> Result<Value, String> {
    let device_id = get_device_id(&params)?;
    let timeout = get_timeout(&params);
    let _conn = shared::get_connection(&device_id, timeout).await?;
    let conn = shared::get_connection(&device_id, timeout).await?;
    let board_def = shared::load_board_def(&device_id).await;
    let signals =
        framelink::board::selectable::list_selectable_signals(&conn.session, board_def.as_ref())
            .await
            .map_err(|e| format!("Failed to list selectable signals: {e}"))?;
    serde_json::to_value(&signals).map_err(|e| e.to_string())
}
