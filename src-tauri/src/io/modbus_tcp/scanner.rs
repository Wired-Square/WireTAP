// io/modbus_tcp/scanner.rs
//
// Modbus TCP Scanner - discovers registers and active unit IDs.
//
// Architecture:
//   - Standalone scanning (not a session) — one-shot discovery operations
//   - Register scan: chunked reads with binary subdivision for efficiency
//   - Unit ID scan: sequential probe of slave addresses 1–247
//   - Results emitted as FrameMessage events for Discovery app consumption

use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter};
use tokio::time::{Duration, sleep};
use tokio_modbus::client::tcp;
use tokio_modbus::prelude::*;

use super::reader::{coils_to_bytes, registers_to_bytes, RegisterType};
use crate::io::{now_us, FrameMessage};

/// Device identification info discovered via FC43 (Read Device Identification)
#[derive(Clone, Debug, Serialize)]
pub struct DeviceInfoPayload {
    pub unit_id: u8,
    pub vendor: Option<String>,
    pub product_code: Option<String>,
    pub revision: Option<String>,
}

// ============================================================================
// Configuration
// ============================================================================

/// Configuration for register range scanning
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModbusScanConfig {
    /// Server hostname or IP
    pub host: String,
    /// Server port (default 502)
    pub port: u16,
    /// Modbus unit/slave ID (1-247)
    pub unit_id: u8,
    /// Register type to scan
    pub register_type: RegisterType,
    /// First register address to scan (protocol-level, 0-based)
    pub start_register: u16,
    /// Last register address to scan (inclusive)
    pub end_register: u16,
    /// Number of registers to read per bulk request (max 125 for holding/input, 2000 for coils)
    pub chunk_size: u16,
    /// Delay between scan requests in milliseconds
    pub inter_request_delay_ms: u64,
}

/// Configuration for unit ID scanning
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UnitIdScanConfig {
    /// Server hostname or IP
    pub host: String,
    /// Server port (default 502)
    pub port: u16,
    /// First unit ID to scan (default 1)
    pub start_unit_id: u8,
    /// Last unit ID to scan (default 247)
    pub end_unit_id: u8,
    /// Register to probe for existence (default 0)
    pub test_register: u16,
    /// Register type to probe (default Holding)
    pub register_type: RegisterType,
    /// Delay between scan requests in milliseconds
    pub inter_request_delay_ms: u64,
}

// ============================================================================
// Event Payloads
// ============================================================================

/// Progress update emitted during scanning
#[derive(Clone, Debug, Serialize)]
pub struct ScanProgressPayload {
    /// Current position in the scan range
    pub current: u32,
    /// Total items to scan
    pub total: u32,
    /// Number of responding items found so far
    pub found_count: u32,
}

/// Completion summary returned when scan finishes
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScanCompletePayload {
    /// Total responding items found
    pub found_count: u32,
    /// Total items scanned
    pub total_scanned: u32,
    /// Scan duration in milliseconds
    pub duration_ms: u64,
}

// ============================================================================
// Register Scanner
// ============================================================================

/// Scan a range of Modbus registers using chunked reads with binary subdivision.
///
/// Strategy:
/// 1. Coarse sweep: read in chunk_size blocks
/// 2. Successful chunks: emit one FrameMessage per register
/// 3. Failed chunks: binary-subdivide and retry each half
/// 4. Base case: single register read failure = register doesn't exist
pub async fn modbus_scan_registers(
    app: AppHandle,
    config: ModbusScanConfig,
    cancel_flag: Arc<AtomicBool>,
) -> Result<ScanCompletePayload, String> {
    let start_time = std::time::Instant::now();

    // Validate
    if config.start_register > config.end_register {
        return Err("Start register must be <= end register".to_string());
    }
    if config.chunk_size == 0 {
        return Err("Chunk size must be > 0".to_string());
    }

    let total_registers = (config.end_register - config.start_register + 1) as u32;
    let type_name = register_type_name(&config.register_type);

    tlog!(
        "[ModbusScan] Starting register scan: {} {} regs {}-{} (chunk={}, delay={}ms)",
        type_name,
        total_registers,
        config.start_register,
        config.end_register,
        config.chunk_size,
        config.inter_request_delay_ms
    );

    // Connect to the Modbus TCP server
    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .map_err(|e| format!("Invalid server address: {}", e))?;

    let slave = Slave(config.unit_id);
    let mut ctx = tcp::connect_slave(addr, slave)
        .await
        .map_err(|e| format!("Failed to connect to Modbus TCP server at {}: {}", addr, e))?;

    tlog!(
        "[ModbusScan] Connected to {}:{} (unit {})",
        config.host,
        config.port,
        config.unit_id
    );

    let mut found_count: u32 = 0;
    let mut scanned_count: u32 = 0;

    // Build list of chunks to scan
    let mut chunks: Vec<(u16, u16)> = Vec::new(); // (start, count)
    let mut pos = config.start_register;
    while pos <= config.end_register {
        let remaining = config.end_register - pos + 1;
        let count = remaining.min(config.chunk_size);
        chunks.push((pos, count));
        pos = pos.saturating_add(count);
    }

    // Process chunks with binary subdivision
    let mut work_queue: Vec<(u16, u16)> = chunks;

    while let Some((start, count)) = work_queue.pop() {
        if cancel_flag.load(Ordering::Relaxed) {
            tlog!("[ModbusScan] Cancelled by user");
            break;
        }

        // Read the chunk
        let result = read_registers(&mut ctx, &config.register_type, start, count).await;

        match result {
            Ok(ReadResult::Registers(data)) => {
                // Success — emit one FrameMessage per register
                let bytes = registers_to_bytes(&data);
                let mut frames = Vec::with_capacity(data.len());
                for i in 0..data.len() {
                    let reg_addr = start + i as u16;
                    let reg_bytes = vec![bytes[i * 2], bytes[i * 2 + 1]];
                    frames.push(FrameMessage {
                        protocol: "modbus".to_string(),
                        timestamp_us: now_us(),
                        frame_id: reg_addr as u32,
                        bus: config.unit_id,
                        dlc: 2,
                        bytes: reg_bytes,
                        is_extended: false,
                        is_fd: false,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    });
                }
                found_count += frames.len() as u32;
                let _ = app.emit("modbus-scan-frame", &frames);
            }
            Ok(ReadResult::Coils(data)) => {
                // Success — emit one FrameMessage per coil (1 byte each with 0/1)
                let mut frames = Vec::with_capacity(data.len());
                for (i, &coil) in data.iter().enumerate() {
                    let reg_addr = start + i as u16;
                    frames.push(FrameMessage {
                        protocol: "modbus".to_string(),
                        timestamp_us: now_us(),
                        frame_id: reg_addr as u32,
                        bus: config.unit_id,
                        dlc: 1,
                        bytes: vec![if coil { 1 } else { 0 }],
                        is_extended: false,
                        is_fd: false,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    });
                }
                found_count += frames.len() as u32;
                let _ = app.emit("modbus-scan-frame", &frames);
            }
            Ok(ReadResult::ModbusException) => {
                // Modbus exception — some or all registers in this chunk don't exist
                if count > 1 {
                    // Subdivide: split into two halves and push back
                    let half = count / 2;
                    let remainder = count - half;
                    // Push second half first so first half is processed next (stack order)
                    work_queue.push((start + half, remainder));
                    work_queue.push((start, half));
                    // Don't count as scanned yet — sub-chunks will be counted
                    continue;
                }
                // Single register failed — it doesn't exist, skip silently
            }
            Err(e) => {
                // IO/connection error — abort scan
                tlog!("[ModbusScan] IO error at register {}: {}", start, e);
                return Err(format!(
                    "Connection error scanning register {}: {}",
                    start, e
                ));
            }
        }

        // Count scanned registers (only for leaf-level reads, not subdivided chunks)
        scanned_count += count as u32;

        // Emit progress
        let _ = app.emit(
            "modbus-scan-progress",
            ScanProgressPayload {
                current: scanned_count,
                total: total_registers,
                found_count,
            },
        );

        // Inter-request delay
        if config.inter_request_delay_ms > 0 {
            sleep(Duration::from_millis(config.inter_request_delay_ms)).await;
        }
    }

    let duration_ms = start_time.elapsed().as_millis() as u64;

    tlog!(
        "[ModbusScan] Register scan complete: found {} of {} {} registers in {}ms",
        found_count,
        total_registers,
        type_name,
        duration_ms
    );

    Ok(ScanCompletePayload {
        found_count,
        total_scanned: total_registers,
        duration_ms,
    })
}

// ============================================================================
// Unit ID Scanner
// ============================================================================

/// Scan for active Modbus unit IDs using FC43 (Read Device Identification).
///
/// For each unit ID, attempts FC43 first to get vendor/product/revision info.
/// Falls back to a single register read if FC43 is not supported.
/// Emits `modbus-scan-frame` for each responding unit and
/// `modbus-scan-device-info` with identification details when available.
pub async fn modbus_scan_unit_ids(
    app: AppHandle,
    config: UnitIdScanConfig,
    cancel_flag: Arc<AtomicBool>,
) -> Result<ScanCompletePayload, String> {
    let start_time = std::time::Instant::now();

    if config.start_unit_id > config.end_unit_id {
        return Err("Start unit ID must be <= end unit ID".to_string());
    }

    let total = (config.end_unit_id - config.start_unit_id + 1) as u32;
    let type_name = register_type_name(&config.register_type);

    tlog!(
        "[ModbusScan] Starting unit ID scan: IDs {}-{}, FC43 + fallback {} reg {} (delay={}ms)",
        config.start_unit_id,
        config.end_unit_id,
        type_name,
        config.test_register,
        config.inter_request_delay_ms
    );

    // Resolve server address
    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .map_err(|e| format!("Invalid server address: {}", e))?;

    let mut found_count: u32 = 0;
    // Track whether the first unit supports FC43 to skip it for subsequent units
    // (if the gateway/server doesn't support it, no unit will)
    let mut fc43_supported = true;
    let mut fc43_tested = false;

    for unit_id in config.start_unit_id..=config.end_unit_id {
        if cancel_flag.load(Ordering::Relaxed) {
            tlog!("[ModbusScan] Unit ID scan cancelled by user");
            break;
        }

        // Connect with the target unit ID
        let slave = Slave(unit_id);
        let connect_result = tcp::connect_slave(addr, slave).await;

        let mut ctx = match connect_result {
            Ok(ctx) => ctx,
            Err(_) => {
                // Connection failed — emit progress and continue
                let scanned = (unit_id - config.start_unit_id + 1) as u32;
                let _ = app.emit(
                    "modbus-scan-progress",
                    ScanProgressPayload {
                        current: scanned,
                        total,
                        found_count,
                    },
                );
                if config.inter_request_delay_ms > 0 {
                    sleep(Duration::from_millis(config.inter_request_delay_ms)).await;
                }
                continue;
            }
        };

        // Try FC43 (Read Device Identification) first
        let mut unit_found = false;
        if fc43_supported {
            match ctx.read_device_identification(ReadCode::Basic, 0x00).await {
                Ok(Ok(response)) => {
                    fc43_tested = true;
                    unit_found = true;

                    // Extract standard identification objects
                    let mut vendor: Option<String> = None;
                    let mut product_code: Option<String> = None;
                    let mut revision: Option<String> = None;

                    for obj in &response.device_id_objects {
                        let text = obj.value_as_str().map(String::from);
                        match obj.id {
                            0x00 => vendor = text,
                            0x01 => product_code = text,
                            0x02 => revision = text,
                            _ => {}
                        }
                    }

                    // Build a summary string for the bytes field
                    let summary = [
                        vendor.as_deref().unwrap_or(""),
                        product_code.as_deref().unwrap_or(""),
                        revision.as_deref().unwrap_or(""),
                    ]
                    .iter()
                    .filter(|s| !s.is_empty())
                    .copied()
                    .collect::<Vec<&str>>()
                    .join(" | ");

                    let summary_bytes = summary.as_bytes().to_vec();

                    let frame = FrameMessage {
                        protocol: "modbus".to_string(),
                        timestamp_us: now_us(),
                        frame_id: 0x2B, // FC43
                        bus: unit_id,
                        dlc: summary_bytes.len() as u8,
                        bytes: summary_bytes,
                        is_extended: false,
                        is_fd: false,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    };
                    found_count += 1;
                    let _ = app.emit("modbus-scan-frame", vec![frame]);

                    // Emit device identification detail event
                    let _ = app.emit(
                        "modbus-scan-device-info",
                        DeviceInfoPayload {
                            unit_id,
                            vendor,
                            product_code,
                            revision,
                        },
                    );

                    tlog!(
                        "[ModbusScan] Unit ID {} identified via FC43: {}",
                        unit_id,
                        summary
                    );
                }
                Ok(Err(_exc)) => {
                    // Modbus exception — unit is alive but doesn't support FC43
                    fc43_tested = true;
                    // Unit responded, so it's alive — fall through to register probe
                    // to get some data, but we already know it exists
                    tlog!(
                        "[ModbusScan] Unit ID {} responded with FC43 exception, trying register fallback",
                        unit_id
                    );
                }
                Err(_) => {
                    // IO error on FC43 — could be unsupported or unit doesn't exist
                    if !fc43_tested {
                        // First attempt — FC43 might not be supported by the gateway
                        fc43_tested = true;
                        fc43_supported = false;
                        tlog!(
                            "[ModbusScan] FC43 not supported by gateway, falling back to register probe"
                        );
                        // Reconnect for register probe (connection may be in bad state)
                        if let Ok(new_ctx) = tcp::connect_slave(addr, slave).await {
                            ctx = new_ctx;
                        } else {
                            let scanned = (unit_id - config.start_unit_id + 1) as u32;
                            let _ = app.emit(
                                "modbus-scan-progress",
                                ScanProgressPayload { current: scanned, total, found_count },
                            );
                            continue;
                        }
                    }
                    // Fall through to register probe
                }
            }
        }

        // If FC43 didn't find the unit, try a register read as fallback
        if !unit_found {
            let result =
                read_registers(&mut ctx, &config.register_type, config.test_register, 1).await;

            match result {
                Ok(ReadResult::Registers(data)) => {
                    let bytes = registers_to_bytes(&data);
                    let frame = FrameMessage {
                        protocol: "modbus".to_string(),
                        timestamp_us: now_us(),
                        frame_id: config.test_register as u32,
                        bus: unit_id,
                        dlc: bytes.len() as u8,
                        bytes,
                        is_extended: false,
                        is_fd: false,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    };
                    found_count += 1;
                    let _ = app.emit("modbus-scan-frame", vec![frame]);
                    tlog!(
                        "[ModbusScan] Unit ID {} responded ({} reg {})",
                        unit_id,
                        type_name,
                        config.test_register
                    );
                }
                Ok(ReadResult::Coils(data)) => {
                    let bytes = coils_to_bytes(&data);
                    let frame = FrameMessage {
                        protocol: "modbus".to_string(),
                        timestamp_us: now_us(),
                        frame_id: config.test_register as u32,
                        bus: unit_id,
                        dlc: bytes.len() as u8,
                        bytes,
                        is_extended: false,
                        is_fd: false,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    };
                    found_count += 1;
                    let _ = app.emit("modbus-scan-frame", vec![frame]);
                    tlog!(
                        "[ModbusScan] Unit ID {} responded ({} reg {})",
                        unit_id,
                        type_name,
                        config.test_register
                    );
                }
                Ok(ReadResult::ModbusException) => {
                    // Unit is alive but doesn't have this register
                    let frame = FrameMessage {
                        protocol: "modbus".to_string(),
                        timestamp_us: now_us(),
                        frame_id: config.test_register as u32,
                        bus: unit_id,
                        dlc: 0,
                        bytes: vec![],
                        is_extended: false,
                        is_fd: false,
                        source_address: None,
                        incomplete: None,
                        direction: Some("rx".to_string()),
                    };
                    found_count += 1;
                    let _ = app.emit("modbus-scan-frame", vec![frame]);
                    tlog!(
                        "[ModbusScan] Unit ID {} alive (exception on reg {})",
                        unit_id,
                        config.test_register
                    );
                }
                Err(_) => {
                    // No response — unit doesn't exist
                }
            }
        }

        // Emit progress
        let scanned = (unit_id - config.start_unit_id + 1) as u32;
        let _ = app.emit(
            "modbus-scan-progress",
            ScanProgressPayload {
                current: scanned,
                total,
                found_count,
            },
        );

        // Inter-request delay
        if config.inter_request_delay_ms > 0 {
            sleep(Duration::from_millis(config.inter_request_delay_ms)).await;
        }
    }

    let duration_ms = start_time.elapsed().as_millis() as u64;

    tlog!(
        "[ModbusScan] Unit ID scan complete: found {} of {} unit IDs in {}ms (FC43={})",
        found_count,
        total,
        duration_ms,
        if fc43_supported { "yes" } else { "no" }
    );

    Ok(ScanCompletePayload {
        found_count,
        total_scanned: total,
        duration_ms,
    })
}

// ============================================================================
// Internal Helpers
// ============================================================================

/// Result of a single Modbus read operation
enum ReadResult {
    /// Holding/input register values
    Registers(Vec<u16>),
    /// Coil/discrete input values
    Coils(Vec<bool>),
    /// Modbus exception (register doesn't exist, etc.)
    ModbusException,
}

/// Read registers of the appropriate type. Returns Ok(ReadResult) for both
/// successful reads and Modbus exceptions, Err for IO/connection errors.
async fn read_registers(
    ctx: &mut tokio_modbus::client::Context,
    register_type: &RegisterType,
    start: u16,
    count: u16,
) -> Result<ReadResult, String> {
    match register_type {
        RegisterType::Holding => match ctx.read_holding_registers(start, count).await {
            Ok(Ok(data)) => Ok(ReadResult::Registers(data)),
            Ok(Err(_)) => Ok(ReadResult::ModbusException),
            Err(e) => Err(format!("IO error: {}", e)),
        },
        RegisterType::Input => match ctx.read_input_registers(start, count).await {
            Ok(Ok(data)) => Ok(ReadResult::Registers(data)),
            Ok(Err(_)) => Ok(ReadResult::ModbusException),
            Err(e) => Err(format!("IO error: {}", e)),
        },
        RegisterType::Coil => match ctx.read_coils(start, count).await {
            Ok(Ok(data)) => Ok(ReadResult::Coils(data)),
            Ok(Err(_)) => Ok(ReadResult::ModbusException),
            Err(e) => Err(format!("IO error: {}", e)),
        },
        RegisterType::Discrete => match ctx.read_discrete_inputs(start, count).await {
            Ok(Ok(data)) => Ok(ReadResult::Coils(data)),
            Ok(Err(_)) => Ok(ReadResult::ModbusException),
            Err(e) => Err(format!("IO error: {}", e)),
        },
    }
}

fn register_type_name(rt: &RegisterType) -> &'static str {
    match rt {
        RegisterType::Holding => "holding",
        RegisterType::Input => "input",
        RegisterType::Coil => "coil",
        RegisterType::Discrete => "discrete",
    }
}
