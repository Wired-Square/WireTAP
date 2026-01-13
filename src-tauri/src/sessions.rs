// ui/src-tauri/src/sessions.rs
//
// Tauri commands for IO session lifecycle.
// Handles session creation, control (start/stop/pause/resume), and destruction.

use crate::{
    buffer_store,
    credentials,
    io::{
        create_session, destroy_session, get_session_capabilities, get_session_joiner_count, get_session_state,
        get_session_listeners, join_session, leave_session, pause_session,
        register_listener, reinitialize_session_if_safe, resume_session,
        seek_session, set_listener_active, start_session, stop_session, transmit_frame, unregister_listener,
        update_session_speed, update_session_time_range, IOCapabilities, IODevice, IOState,
        JoinSessionResult, ListenerInfo, RegisterListenerResult, ReinitializeResult, BufferReader,
        CsvReader, CsvReaderOptions,
        GvretReader,
        GvretUsbConfig, GvretUsbReader,
        MqttConfig, MqttReader,
        Parity, PostgresConfig, PostgresReader, PostgresReaderOptions, PostgresSourceType,
        SerialConfig, SerialFramingConfig, SerialReader,
        SlcanConfig, SlcanReader,
        SocketCanConfig, SocketIODevice,
        CanTransmitFrame, TransmitResult,
    },
    profile_tracker,
    serial_framer::{FrameIdConfig, FramingEncoding},
    settings::{self, AppSettings, IOProfile},
};

#[cfg(any(target_os = "windows", target_os = "macos"))]
use crate::io::{GsUsbConfig, GsUsbReader};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;

/// Map of session_id -> profile_id for tracking which profile each reader session uses.
/// Used to unregister profile usage when a session is destroyed.
static SESSION_PROFILES: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Track that a session is using a specific profile
fn register_session_profile(session_id: &str, profile_id: &str) {
    if let Ok(mut map) = SESSION_PROFILES.lock() {
        map.insert(session_id.to_string(), profile_id.to_string());
    }
}

/// Get and remove the profile_id for a session (called during destroy)
fn take_session_profile(session_id: &str) -> Option<String> {
    SESSION_PROFILES.lock().ok()?.remove(session_id)
}

/// Get a secure credential for a profile, checking keyring if marked as stored there.
fn get_secure_credential(profile: &IOProfile, field: &str) -> Option<String> {
    // Check if the credential is stored in keyring
    let stored_key = format!("_{}_stored", field);
    let is_stored_in_keyring = profile
        .connection
        .get(&stored_key)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if is_stored_in_keyring {
        // Try to fetch from keyring
        match credentials::get_credential(&profile.id, field) {
            Ok(Some(value)) => Some(value),
            Ok(None) => {
                eprintln!(
                    "[get_secure_credential] No {} found in keyring for profile {}",
                    field, profile.id
                );
                None
            }
            Err(e) => {
                eprintln!(
                    "[get_secure_credential] Failed to get {} from keyring for profile {}: {}",
                    field, profile.id, e
                );
                None
            }
        }
    } else {
        // Fall back to connection field (for backward compatibility with old profiles)
        profile
            .connection
            .get(field)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }
}

fn choose_profile_by_id(settings: &AppSettings, profile_id: Option<&str>) -> Option<IOProfile> {
    if let Some(id) = profile_id {
        settings.io_profiles.iter().find(|p| p.id == id).cloned()
    } else if let Some(id) = &settings.default_read_profile {
        settings.io_profiles.iter().find(|p| p.id == *id).cloned()
    } else {
        // Return the first profile as a fallback
        settings.io_profiles.first().cloned()
    }
}

/// Create a new reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn create_reader_session(
    app: tauri::AppHandle,
    session_id: String,
    profile_id: Option<String>,
    start_time: Option<String>,
    end_time: Option<String>,
    speed: Option<f64>,
    limit: Option<i64>,
    file_path: Option<String>,
    // Framing configuration for serial readers
    framing_encoding: Option<String>,
    delimiter: Option<Vec<u8>>,
    max_frame_length: Option<usize>,
    frame_id_start_byte: Option<i32>,
    frame_id_bytes: Option<u8>,
    frame_id_big_endian: Option<bool>,
    source_address_start_byte: Option<i32>,
    source_address_bytes: Option<u8>,
    source_address_big_endian: Option<bool>,
    min_frame_length: Option<usize>,
    emit_raw_bytes: Option<bool>,
) -> Result<IOCapabilities, String> {
    let settings = settings::load_settings(app.clone())
        .await
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    let profile = choose_profile_by_id(&settings, profile_id.as_deref())
        .ok_or_else(|| "No IO profile configured".to_string())?;

    // Check if this profile is already in use (for single-handle devices)
    profile_tracker::can_use_profile(&profile.id, &profile.kind)?;

    // Track profile_id for later registration
    let profile_id_for_tracking = profile.id.clone();

    // Create the appropriate reader based on profile kind
    let reader: Box<dyn IODevice> = match profile.kind.as_str() {
        "gvret_tcp" | "gvret-tcp" => {
            let host = profile
                .connection
                .get("host")
                .and_then(|v| v.as_str())
                .unwrap_or("127.0.0.1")
                .to_string();
            let port = profile
                .connection
                .get("port")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(23) as u16;
            let timeout_sec = profile
                .connection
                .get("timeout")
                .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(5.0);

            Box::new(GvretReader::new(
                app.clone(),
                session_id.clone(),
                host,
                port,
                timeout_sec,
                limit,
            ))
        }
        "gvret_usb" | "gvret-usb" => {
            let port = profile
                .connection
                .get("port")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Serial port is required for GVRET USB".to_string())?
                .to_string();

            let baud_rate = profile
                .connection
                .get("baud_rate")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(115200) as u32;

            let config = GvretUsbConfig {
                port,
                baud_rate,
                limit,
                display_name: Some(profile.name.clone()),
            };

            Box::new(GvretUsbReader::new(app.clone(), session_id.clone(), config))
        }
        "postgres" => {
            let config = PostgresConfig {
                host: profile
                    .connection
                    .get("host")
                    .and_then(|v| v.as_str())
                    .unwrap_or("localhost")
                    .to_string(),
                port: profile
                    .connection
                    .get("port")
                    .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(5432) as u16,
                database: profile
                    .connection
                    .get("database")
                    .or_else(|| profile.connection.get("db"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "PostgreSQL database name is required".to_string())?
                    .to_string(),
                username: profile
                    .connection
                    .get("username")
                    .or_else(|| profile.connection.get("user"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "PostgreSQL username is required".to_string())?
                    .to_string(),
                password: get_secure_credential(&profile, "password"),
                sslmode: profile
                    .connection
                    .get("sslmode")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            };

            // Use provided time range or fall back to profile settings
            let start_from_profile = profile
                .connection
                .get("start")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let end_from_profile = profile
                .connection
                .get("end")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            eprintln!(
                "[create_reader_session] PostgreSQL time range - param start: {:?}, param end: {:?}, profile start: {:?}, profile end: {:?}",
                start_time, end_time, start_from_profile, end_from_profile
            );

            // Use provided limit or fall back to profile settings
            let limit_from_profile = profile.connection.get("limit").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));

            // Extract source type (defaults to can_frame for backward compatibility)
            let source_type = profile
                .connection
                .get("source_type")
                .and_then(|v| v.as_str())
                .map(PostgresSourceType::from_str)
                .unwrap_or_default();

            let options = PostgresReaderOptions {
                source_type,
                start: start_time.or(start_from_profile),
                end: end_time.or(end_from_profile),
                limit: limit.or(limit_from_profile),
                speed: speed.unwrap_or_else(|| {
                    profile
                        .connection
                        .get("speed")
                        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                        .unwrap_or(0.0) // 0 = no limit (no pacing) by default
                }),
                batch_size: profile
                    .connection
                    .get("batch_size")
                    .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(1000) as i32,
            };

            Box::new(PostgresReader::new(
                app.clone(),
                session_id.clone(),
                config,
                options,
            ))
        }
        "csv_file" | "csv-file" => {
            // Use file_path parameter if provided, otherwise fall back to profile's configured path
            let profile_file_path = profile
                .connection
                .get("file_path")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());

            let path = file_path.or(profile_file_path).ok_or_else(|| {
                "CSV file path is required. Please select a file or configure a path in the profile.".to_string()
            })?;

            let options = CsvReaderOptions {
                file_path: path,
                speed: speed.unwrap_or_else(|| {
                    profile
                        .connection
                        .get("default_speed")
                        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                        .unwrap_or(0.0) // 0 = no limit by default
                }),
            };

            Box::new(CsvReader::new(app.clone(), session_id.clone(), options))
        }
        "serial" => {
            let port = profile
                .connection
                .get("port")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Serial port is required".to_string())?
                .to_string();

            let baud_rate = profile
                .connection
                .get("baud_rate")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(115200) as u32;

            let data_bits = profile
                .connection
                .get("data_bits")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(8) as u8;

            let stop_bits = profile
                .connection
                .get("stop_bits")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(1) as u8;

            let parity = match profile
                .connection
                .get("parity")
                .and_then(|v| v.as_str())
                .unwrap_or("none")
            {
                "odd" => Parity::Odd,
                "even" => Parity::Even,
                _ => Parity::None,
            };

            // Build framing config if encoding is specified
            eprintln!(
                "[create_reader_session] Serial framing params: encoding={:?}, frame_id_start={:?}, frame_id_bytes={:?}, frame_id_big_endian={:?}",
                framing_encoding, frame_id_start_byte, frame_id_bytes, frame_id_big_endian
            );
            let framing = framing_encoding.as_deref().and_then(|enc| {
                let encoding = match enc {
                    "slip" => Some(FramingEncoding::Slip),
                    "modbus_rtu" => Some(FramingEncoding::ModbusRtu {
                        device_address: None, // TODO: add parameter
                        validate_crc: true,
                    }),
                    "delimiter" => Some(FramingEncoding::Delimiter {
                        delimiter: delimiter.clone().unwrap_or_else(|| vec![0x0D, 0x0A]),
                        max_length: max_frame_length.unwrap_or(256),
                        include_delimiter: false,
                    }),
                    _ => None, // "raw" or unknown = no framing
                };

                encoding.map(|enc| SerialFramingConfig {
                    encoding: enc,
                    frame_id_config: frame_id_start_byte.map(|start| FrameIdConfig {
                        start_byte: start,
                        num_bytes: frame_id_bytes.unwrap_or(1),
                        big_endian: frame_id_big_endian.unwrap_or(false),
                    }),
                    source_address_config: source_address_start_byte.map(|start| FrameIdConfig {
                        start_byte: start,
                        num_bytes: source_address_bytes.unwrap_or(1),
                        big_endian: source_address_big_endian.unwrap_or(false),
                    }),
                    min_frame_length,
                    emit_raw_bytes: emit_raw_bytes.unwrap_or(true),
                })
            });

            let config = SerialConfig {
                port,
                baud_rate,
                data_bits,
                stop_bits,
                parity,
                framing,
                limit,
                display_name: Some(profile.name.clone()),
            };

            Box::new(SerialReader::new(app.clone(), session_id.clone(), config))
        }
        "slcan" => {
            let port = profile
                .connection
                .get("port")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Serial port is required for slcan".to_string())?
                .to_string();

            let baud_rate = profile
                .connection
                .get("baud_rate")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(115200) as u32;

            let bitrate = profile
                .connection
                .get("bitrate")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(500000) as u32;

            let silent_mode = profile
                .connection
                .get("silent_mode")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);

            // Serial framing parameters (advanced options, defaults to 8N1)
            let data_bits = profile
                .connection
                .get("data_bits")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(8) as u8;

            let stop_bits = profile
                .connection
                .get("stop_bits")
                .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(1) as u8;

            let parity = profile
                .connection
                .get("parity")
                .and_then(|v| v.as_str())
                .unwrap_or("none")
                .to_string();

            let config = SlcanConfig {
                port,
                baud_rate,
                bitrate,
                silent_mode,
                limit,
                display_name: Some(profile.name.clone()),
                data_bits,
                stop_bits,
                parity,
            };

            Box::new(SlcanReader::new(app.clone(), session_id.clone(), config))
        }
        "socketcan" => {
            let interface = profile
                .connection
                .get("interface")
                .and_then(|v| v.as_str())
                .unwrap_or("can0")
                .to_string();

            let config = SocketCanConfig {
                interface,
                limit,
                display_name: Some(profile.name.clone()),
            };

            Box::new(SocketIODevice::new(app.clone(), session_id.clone(), config))
        }
        "gs_usb" => {
            // gs_usb (candleLight) support
            // - Linux: Uses SocketCAN (kernel gs_usb driver exposes device as canX interface)
            // - Windows/macOS: Uses direct USB access via nusb

            #[cfg(target_os = "linux")]
            {
                // On Linux, gs_usb devices appear as SocketCAN interfaces
                let interface = profile
                    .connection
                    .get("interface")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        "CAN interface is required for gs_usb on Linux. \
                        Run 'sudo ip link set canX up type can bitrate NNNN' first."
                            .to_string()
                    })?
                    .to_string();

                let config = SocketCanConfig {
                    interface,
                    limit,
                    display_name: Some(profile.name.clone()),
                };

                Box::new(SocketIODevice::new(app.clone(), session_id.clone(), config))
            }

            #[cfg(any(target_os = "windows", target_os = "macos"))]
            {
                let bus = profile
                    .connection
                    .get("bus")
                    .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(0) as u8;

                let address = profile
                    .connection
                    .get("address")
                    .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(0) as u8;

                let bitrate = profile
                    .connection
                    .get("bitrate")
                    .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(500_000) as u32;

                let listen_only = profile
                    .connection
                    .get("listen_only")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                let channel = profile
                    .connection
                    .get("channel")
                    .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(0) as u8;

                let config = GsUsbConfig {
                    bus,
                    address,
                    bitrate,
                    listen_only,
                    channel,
                    limit,
                    display_name: Some(profile.name.clone()),
                };

                Box::new(GsUsbReader::new(app.clone(), session_id.clone(), config))
            }

            #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
            {
                return Err(
                    "gs_usb is not supported on this platform. \
                    Consider using slcan firmware instead."
                        .to_string(),
                );
            }
        }
        "mqtt" => {
            let host = profile
                .connection
                .get("host")
                .and_then(|v| v.as_str())
                .unwrap_or("localhost")
                .to_string();

            let port = profile
                .connection
                .get("port")
                .and_then(|v| {
                    v.as_str()
                        .and_then(|s| s.parse().ok())
                        .or_else(|| v.as_i64().map(|n| n as u16))
                })
                .unwrap_or(1883);

            let username = profile
                .connection
                .get("username")
                .and_then(|v| v.as_str())
                .map(String::from);

            // Get password from keyring if stored, otherwise from profile
            let password_stored = profile
                .connection
                .get("_password_stored")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let password = if password_stored {
                credentials::get_credential(&profile.id, "password").ok().flatten()
            } else {
                profile
                    .connection
                    .get("password")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            };

            // Get subscription topic from savvycan format config
            let topic = profile
                .connection
                .get("formats")
                .and_then(|f| f.get("savvycan"))
                .and_then(|s| s.get("topic"))
                .and_then(|v| v.as_str())
                .unwrap_or("candor/#")
                .to_string();

            let config = MqttConfig {
                host,
                port,
                username,
                password,
                topic,
                client_id: None,
                display_name: Some(profile.name.clone()),
            };

            Box::new(MqttReader::new(app.clone(), session_id.clone(), config))
        }
        kind => {
            return Err(format!(
                "Unsupported reader type '{}'. Supported: mqtt, gvret_tcp, gvret_usb, postgres, csv_file, serial, slcan, socketcan, gs_usb",
                kind
            ));
        }
    };

    let result = create_session(app, session_id.clone(), reader, None).await;

    // Register profile usage for all profile kinds
    // This allows other apps (like Transmit) to find and join existing sessions
    profile_tracker::register_usage(&profile_id_for_tracking, &session_id);
    register_session_profile(&session_id, &profile_id_for_tracking);

    // Auto-start the session after creation (only if this is a new session)
    // If we joined an existing session, it's already running
    if result.is_new {
        eprintln!("[create_reader_session] Auto-starting new session '{}'", session_id);
        if let Err(e) = start_session(&session_id).await {
            eprintln!("[create_reader_session] Failed to auto-start session '{}': {}", session_id, e);
            // Don't fail the whole creation - session is created but not started
        }
    } else {
        eprintln!("[create_reader_session] Joined existing session '{}' (listener_count: {})", session_id, result.listener_count);
    }

    Ok(result.capabilities)
}

/// Get the state of a reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn get_reader_session_state(session_id: String) -> Result<Option<IOState>, String> {
    Ok(get_session_state(&session_id).await)
}

/// Get the capabilities of a reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn get_reader_session_capabilities(
    session_id: String,
) -> Result<Option<IOCapabilities>, String> {
    Ok(get_session_capabilities(&session_id).await)
}

/// Join an existing reader session (for session sharing between apps).
/// Returns session info if session exists, error if not.
/// The caller can then set up event listeners to receive frames and state changes.
#[tauri::command(rename_all = "snake_case")]
pub async fn join_reader_session(session_id: String) -> Result<JoinSessionResult, String> {
    join_session(&session_id).await
}

/// Leave a reader session without stopping it.
/// Call this when you want to stop listening but not stop the session.
/// Returns the new joiner count.
#[tauri::command(rename_all = "snake_case")]
pub async fn leave_reader_session(session_id: String) -> Result<usize, String> {
    leave_session(&session_id).await
}

/// Get the joiner count for a reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn get_reader_session_joiner_count(session_id: String) -> Result<usize, String> {
    Ok(get_session_joiner_count(&session_id).await)
}

/// Start a reader session
/// Returns the confirmed state after the operation.
#[tauri::command(rename_all = "snake_case")]
pub async fn start_reader_session(session_id: String) -> Result<IOState, String> {
    eprintln!("[tauri cmd] start_reader_session('{}') called", session_id);
    let result = start_session(&session_id).await;
    eprintln!("[tauri cmd] start_reader_session('{}') result: {:?}", session_id, result);
    result
}

/// Stop a reader session
/// Returns the confirmed state after the operation.
#[tauri::command(rename_all = "snake_case")]
pub async fn stop_reader_session(session_id: String) -> Result<IOState, String> {
    stop_session(&session_id).await
}

/// Pause a reader session
/// Returns the confirmed state after the operation.
#[tauri::command(rename_all = "snake_case")]
pub async fn pause_reader_session(session_id: String) -> Result<IOState, String> {
    pause_session(&session_id).await
}

/// Resume a reader session
/// Returns the confirmed state after the operation.
#[tauri::command(rename_all = "snake_case")]
pub async fn resume_reader_session(session_id: String) -> Result<IOState, String> {
    resume_session(&session_id).await
}

/// Update playback speed for a reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn update_reader_speed(session_id: String, speed: f64) -> Result<(), String> {
    update_session_speed(&session_id, speed).await
}

/// Update time range for a reader session (only works when stopped)
#[tauri::command(rename_all = "snake_case")]
pub async fn update_reader_time_range(
    session_id: String,
    start: Option<String>,
    end: Option<String>,
) -> Result<(), String> {
    update_session_time_range(&session_id, start, end).await
}

/// Seek to a specific timestamp in microseconds
#[tauri::command(rename_all = "snake_case")]
pub async fn seek_reader_session(session_id: String, timestamp_us: i64) -> Result<(), String> {
    seek_session(&session_id, timestamp_us).await
}

/// Destroy a reader session
#[tauri::command(rename_all = "snake_case")]
pub async fn destroy_reader_session(session_id: String) -> Result<(), String> {
    // Unregister profile usage if this session was tracking a profile
    if let Some(profile_id) = take_session_profile(&session_id) {
        profile_tracker::unregister_usage(&profile_id);
    }

    destroy_session(&session_id).await
}

/// Create a reader session for the shared buffer
#[tauri::command(rename_all = "snake_case")]
pub async fn create_buffer_reader_session(
    app: tauri::AppHandle,
    session_id: String,
    speed: Option<f64>,
) -> Result<IOCapabilities, String> {
    if !buffer_store::has_data() {
        return Err("No data in buffer. Please import a CSV file first.".to_string());
    }

    let reader = BufferReader::new(
        app.clone(),
        session_id.clone(),
        speed.unwrap_or(0.0), // 0 = no limit by default
    );

    let result = create_session(app, session_id, Box::new(reader), None).await;
    Ok(result.capabilities)
}

/// Transition an existing session to use the shared buffer for replay
/// This is used when a streaming source (GVRET, PostgreSQL) ends and
/// the user wants to replay the captured frames.
#[tauri::command(rename_all = "snake_case")]
pub async fn transition_to_buffer_reader(
    app: tauri::AppHandle,
    session_id: String,
    speed: Option<f64>,
) -> Result<IOCapabilities, String> {
    // Stop and destroy current session
    let _ = stop_session(&session_id).await;
    let _ = destroy_session(&session_id).await;

    if !buffer_store::has_data() {
        return Err("No data in buffer for replay".to_string());
    }

    // Create BufferReader with the captured frames
    let reader = BufferReader::new(
        app.clone(),
        session_id.clone(),
        speed.unwrap_or(1.0), // Default to 1x speed for replay
    );

    let result = create_session(app, session_id, Box::new(reader), None).await;
    Ok(result.capabilities)
}

// Legacy heartbeat commands removed - use register_session_listener/unregister_session_listener instead

/// Transmit a CAN frame through a session.
/// The session must be connected and support transmission.
#[tauri::command(rename_all = "snake_case")]
pub async fn session_transmit_frame(
    session_id: String,
    frame: CanTransmitFrame,
) -> Result<TransmitResult, String> {
    transmit_frame(&session_id, &frame).await
}

// ============================================================================
// Listener Registration Commands
// ============================================================================

/// Register a listener for a session.
/// This is the primary way for frontend components to join a session.
/// If the listener is already registered, this updates their heartbeat.
/// Returns session info including whether this listener is the owner.
#[tauri::command(rename_all = "snake_case")]
pub async fn register_session_listener(
    session_id: String,
    listener_id: String,
) -> Result<RegisterListenerResult, String> {
    register_listener(&session_id, &listener_id).await
}

/// Unregister a listener from a session.
/// If this was the last listener, the session will be stopped (but not destroyed).
/// Returns the remaining listener count.
#[tauri::command(rename_all = "snake_case")]
pub async fn unregister_session_listener(
    session_id: String,
    listener_id: String,
) -> Result<usize, String> {
    unregister_listener(&session_id, &listener_id).await
}

/// Get all listeners for a session.
/// Useful for debugging and for the frontend to understand session state.
#[tauri::command(rename_all = "snake_case")]
pub async fn get_session_listener_list(session_id: String) -> Result<Vec<ListenerInfo>, String> {
    get_session_listeners(&session_id).await
}

/// Check if it's safe to reinitialize a session and do so if safe.
/// Reinitialize is only safe if the requesting listener is the only listener.
/// This is an atomic check-and-act operation to prevent race conditions.
///
/// If safe, the session will be destroyed so a new one can be created.
/// Returns success status and reason if failed.
#[tauri::command(rename_all = "snake_case")]
pub async fn reinitialize_session_if_safe_cmd(
    session_id: String,
    listener_id: String,
) -> Result<ReinitializeResult, String> {
    reinitialize_session_if_safe(&session_id, &listener_id).await
}

/// Set whether a listener is active (receiving frames).
/// When a listener detaches, set is_active to false to stop receiving frames.
/// When they rejoin, set is_active to true to resume receiving frames.
/// This is handled in Rust to avoid frontend race conditions.
#[tauri::command(rename_all = "snake_case")]
pub async fn set_session_listener_active(
    session_id: String,
    listener_id: String,
    is_active: bool,
) -> Result<(), String> {
    set_listener_active(&session_id, &listener_id, is_active).await
}
