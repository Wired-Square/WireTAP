// ui/src-tauri/src/io/mqtt/reader.rs
//
// MQTT Reader - streams CAN frames from an MQTT broker.
// Supports SavvyCAN JSON format with optional CAN FD.
//
// JSON message format:
// {
//   "bus": 0,           // CAN bus number (optional, default 0)
//   "id": 291,          // CAN ID (decimal)
//   "dlc": 8,           // Data length code
//   "data": [0,1,2...], // Byte array (up to 8 for classic, 64 for FD)
//   "extended": false,  // Extended ID (optional, default false)
//   "fd": false         // CAN FD frame (optional, default false)
// }

use async_trait::async_trait;
use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS};
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::AppHandle;
use tokio::time::Duration;

use crate::io::{emit_frames, emit_stream_ended, emit_to_session, now_us, FrameMessage, IOCapabilities, IODevice, IOState};
use crate::buffer_store::{self, BufferType};

// ============================================================================
// Configuration
// ============================================================================

/// MQTT reader configuration
#[derive(Clone, Debug)]
pub struct MqttConfig {
    /// MQTT broker hostname
    pub host: String,
    /// MQTT broker port
    pub port: u16,
    /// Username for authentication (optional)
    pub username: Option<String>,
    /// Password for authentication (optional)
    pub password: Option<String>,
    /// Topic pattern to subscribe to (supports MQTT wildcards: +, #)
    pub topic: String,
    /// Client ID (auto-generated if None)
    pub client_id: Option<String>,
    /// Display name for the reader
    pub display_name: Option<String>,
}

impl Default for MqttConfig {
    fn default() -> Self {
        Self {
            host: "localhost".to_string(),
            port: 1883,
            username: None,
            password: None,
            topic: "candor/#".to_string(),
            client_id: None,
            display_name: None,
        }
    }
}

// ============================================================================
// JSON Message Format
// ============================================================================

/// SavvyCAN-compatible JSON message format
#[derive(Debug, Deserialize)]
struct MqttCanFrame {
    /// CAN bus number (default 0)
    #[serde(default)]
    bus: u8,
    /// CAN ID (decimal or hex string)
    #[serde(deserialize_with = "deserialize_can_id")]
    id: u32,
    /// Data length code
    #[serde(default)]
    dlc: u8,
    /// Frame data as byte array
    #[serde(default)]
    data: Vec<u8>,
    /// Extended (29-bit) ID frame
    #[serde(default)]
    extended: bool,
    /// CAN FD frame (allows up to 64 bytes)
    #[serde(default)]
    fd: bool,
}

/// Deserialize CAN ID from either integer or hex string
fn deserialize_can_id<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{self, Visitor};

    struct CanIdVisitor;

    impl<'de> Visitor<'de> for CanIdVisitor {
        type Value = u32;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("an integer or hex string")
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(v as u32)
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(v as u32)
        }

        fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
            // Try parsing as hex (with or without 0x prefix)
            let s = v.trim_start_matches("0x").trim_start_matches("0X");
            u32::from_str_radix(s, 16).or_else(|_| {
                // Fall back to decimal
                v.parse::<u32>().map_err(de::Error::custom)
            })
        }
    }

    deserializer.deserialize_any(CanIdVisitor)
}

// ============================================================================
// MQTT Reader
// ============================================================================

/// MQTT Reader - receives CAN frames from an MQTT broker
pub struct MqttReader {
    app: AppHandle,
    session_id: String,
    config: MqttConfig,
    state: IOState,
    cancel_flag: Arc<AtomicBool>,
    task_handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl MqttReader {
    pub fn new(app: AppHandle, session_id: String, config: MqttConfig) -> Self {
        Self {
            app,
            session_id,
            config,
            state: IOState::Stopped,
            cancel_flag: Arc::new(AtomicBool::new(false)),
            task_handle: None,
        }
    }
}

#[async_trait]
impl IODevice for MqttReader {
    fn capabilities(&self) -> IOCapabilities {
        IOCapabilities::realtime_can()
            .with_canfd(true)
            .with_buses(vec![])
    }

    async fn start(&mut self) -> Result<(), String> {
        if self.state == IOState::Running {
            return Err("Reader is already running".to_string());
        }

        self.state = IOState::Starting;
        self.cancel_flag.store(false, Ordering::Relaxed);

        let app = self.app.clone();
        let session_id = self.session_id.clone();
        let config = self.config.clone();
        let cancel_flag = self.cancel_flag.clone();

        let handle = spawn_mqtt_stream(app, session_id, config, cancel_flag);
        self.task_handle = Some(handle);
        self.state = IOState::Running;

        Ok(())
    }

    async fn stop(&mut self) -> Result<(), String> {
        self.cancel_flag.store(true, Ordering::Relaxed);

        if let Some(handle) = self.task_handle.take() {
            let _ = handle.await;
        }

        self.state = IOState::Stopped;
        Ok(())
    }

    async fn pause(&mut self) -> Result<(), String> {
        Err("MQTT is a live stream and cannot be paused. Data would be lost.".to_string())
    }

    async fn resume(&mut self) -> Result<(), String> {
        Err("MQTT is a live stream and does not support pause/resume.".to_string())
    }

    fn set_speed(&mut self, _speed: f64) -> Result<(), String> {
        Err("MQTT is a live stream and does not support speed control.".to_string())
    }

    fn set_time_range(
        &mut self,
        _start: Option<String>,
        _end: Option<String>,
    ) -> Result<(), String> {
        Err("MQTT is a live stream and does not support time range filtering.".to_string())
    }

    fn state(&self) -> IOState {
        self.state.clone()
    }

    fn session_id(&self) -> &str {
        &self.session_id
    }
}

// ============================================================================
// MQTT Stream Task
// ============================================================================

fn spawn_mqtt_stream(
    app_handle: AppHandle,
    session_id: String,
    config: MqttConfig,
    cancel_flag: Arc<AtomicBool>,
) -> tauri::async_runtime::JoinHandle<()> {
    let source = format!("mqtt://{}:{}", config.host, config.port);

    tauri::async_runtime::spawn(async move {
        // Create a frame buffer for this MQTT session
        let buffer_name = config
            .display_name
            .clone()
            .unwrap_or_else(|| format!("MQTT {}", source));
        let _buffer_id = buffer_store::create_buffer(BufferType::Frames, buffer_name);

        #[allow(unused_assignments)]
        let mut stream_reason = "disconnected";

        // Generate client ID if not provided
        let client_id = config.client_id.clone().unwrap_or_else(|| {
            format!("candor-{}", uuid_simple())
        });

        // Configure MQTT options
        let mut mqttoptions = MqttOptions::new(&client_id, &config.host, config.port);
        mqttoptions.set_keep_alive(Duration::from_secs(30));

        // Set credentials if provided
        if let (Some(username), Some(password)) = (&config.username, &config.password) {
            mqttoptions.set_credentials(username, password);
        }

        // Create async client
        let (client, mut eventloop) = AsyncClient::new(mqttoptions, 100);

        // Subscribe to topic
        if let Err(e) = client.subscribe(&config.topic, QoS::AtMostOnce).await {
            emit_to_session(
                &app_handle,
                "session-error",
                &session_id,
                format!("Failed to subscribe to {}: {}", config.topic, e),
            );
            stream_reason = "error";
            emit_stream_ended(&app_handle, &session_id, stream_reason, "MQTT");
            return;
        }

        eprintln!(
            "[MQTT:{}] Connected to {}:{}, subscribed to '{}'",
            session_id, config.host, config.port, config.topic
        );

        // Process incoming messages
        loop {
            if cancel_flag.load(Ordering::Relaxed) {
                stream_reason = "stopped";
                break;
            }

            // Poll with timeout to check cancel flag periodically
            match tokio::time::timeout(Duration::from_millis(100), eventloop.poll()).await {
                Ok(Ok(event)) => {
                    if let Event::Incoming(Packet::Publish(publish)) = event {
                        // Try to parse the message as JSON
                        match serde_json::from_slice::<MqttCanFrame>(&publish.payload) {
                            Ok(mqtt_frame) => {
                                let frame = FrameMessage {
                                    protocol: "can".to_string(),
                                    timestamp_us: now_us(),
                                    frame_id: mqtt_frame.id,
                                    bus: mqtt_frame.bus,
                                    dlc: if mqtt_frame.dlc > 0 {
                                        mqtt_frame.dlc
                                    } else {
                                        mqtt_frame.data.len() as u8
                                    },
                                    bytes: mqtt_frame.data,
                                    is_extended: mqtt_frame.extended,
                                    is_fd: mqtt_frame.fd,
                                    source_address: None,
                                    incomplete: None,
                                    direction: Some("rx".to_string()),
                                };

                                // Buffer frame for replay
                                buffer_store::append_frames(vec![frame.clone()]);

                                // Emit to frontend
                                emit_frames(&app_handle, &session_id, vec![frame]);
                            }
                            Err(e) => {
                                // Log parse error but continue (might be non-CAN message)
                                eprintln!(
                                    "[MQTT:{}] Failed to parse message on '{}': {}",
                                    session_id, publish.topic, e
                                );
                            }
                        }
                    }
                }
                Ok(Err(e)) => {
                    // Connection error
                    emit_to_session(
                        &app_handle,
                        "session-error",
                        &session_id,
                        format!("MQTT error: {}", e),
                    );
                    stream_reason = "error";
                    break;
                }
                Err(_) => {
                    // Timeout - continue loop to check cancel flag
                }
            }
        }

        // Disconnect cleanly
        let _ = client.disconnect().await;

        eprintln!("[MQTT:{}] Stream ended: {}", session_id, stream_reason);
        emit_stream_ended(&app_handle, &session_id, stream_reason, "MQTT");
    })
}

/// Generate a simple UUID-like string for client IDs
fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", timestamp)
}
