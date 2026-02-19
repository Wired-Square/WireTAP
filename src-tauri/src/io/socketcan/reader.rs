// ui/src-tauri/src/io/socketcan/reader.rs
//
// SocketCAN reader for Linux native CAN interfaces.
// Used with CANable Pro (Candlelight firmware) or native CAN hardware.
//
// Requires the interface to be configured first:
//   sudo ip link set can0 up type can bitrate 500000
//
// This module is only compiled on Linux.

#[cfg(target_os = "linux")]
mod linux_impl {
    use serde::{Deserialize, Serialize};
    use socketcan::{
        CanAnyFrame, CanDataFrame, CanFdFrame, CanFdSocket, EmbeddedFrame, ExtendedId, Frame, Id,
        Socket, StandardId,
    };
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc as std_mpsc,
        Arc,
    };
    use std::time::Duration;
    use tokio::sync::mpsc;

    use crate::io::error::IoError;
    use crate::io::gvret::{apply_bus_mapping, BusMapping};
    use crate::io::types::{SourceMessage, TransmitRequest};
    use crate::io::{now_us, CanTransmitFrame, FrameMessage};

    // ============================================================================
    // Types and Configuration
    // ============================================================================

    /// SocketCAN reader configuration
    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub struct SocketCanConfig {
        /// CAN interface name (e.g., "can0", "vcan0")
        pub interface: String,
        /// CAN bitrate in bits/second (e.g., 500000 for 500 Kbit/s).
        /// If set, the interface will be configured automatically using pkexec.
        /// If None, the interface is used as already configured by the system.
        #[serde(default)]
        pub bitrate: Option<u32>,
        /// Maximum number of frames to read (None = unlimited)
        pub limit: Option<i64>,
        /// Display name for the reader
        pub display_name: Option<String>,
        /// Bus number override - assigns a specific bus number to all frames from this device.
        /// Used for multi-bus capture where multiple single-bus devices are combined.
        /// If None, defaults to bus 0.
        #[serde(default)]
        pub bus_override: Option<u8>,
        /// Enable CAN FD mode.
        /// Requires an FD-capable interface and hardware.
        #[serde(default)]
        pub enable_fd: bool,
        /// CAN FD data phase bitrate in bits/second (e.g., 2000000 for 2 Mbit/s).
        /// Only used when enable_fd is true.
        #[serde(default)]
        pub data_bitrate: Option<u32>,
    }

    // ============================================================================
    // Interface Configuration
    // ============================================================================

    /// Configure a SocketCAN interface using pkexec for privilege escalation.
    /// This brings down the interface, sets the bitrate, and brings it back up.
    /// If enable_fd is true, the interface is configured for CAN FD mode.
    ///
    /// Returns Ok(()) on success, or an error message on failure.
    pub fn configure_interface(
        interface: &str,
        bitrate: u32,
        enable_fd: bool,
        data_bitrate: Option<u32>,
    ) -> Result<(), String> {
        use std::process::Command;

        eprintln!(
            "[socketcan] Configuring interface {} with bitrate {}{} using pkexec",
            interface,
            bitrate,
            if enable_fd {
                format!(" (FD mode, dbitrate: {:?})", data_bitrate)
            } else {
                String::new()
            }
        );

        // Build the shell command to configure the interface
        // We use a single pkexec call with sh -c to run all commands in sequence
        let mut script = format!(
            "ip link set {iface} down && ip link set {iface} type can bitrate {bitrate}",
            iface = interface,
            bitrate = bitrate
        );

        // Add FD configuration if enabled
        if enable_fd {
            script.push_str(" fd on");
            if let Some(dbitrate) = data_bitrate {
                script.push_str(&format!(" dbitrate {}", dbitrate));
            }
        }

        script.push_str(&format!(" && ip link set {} up", interface));

        let output = Command::new("pkexec")
            .args(["sh", "-c", &script])
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "pkexec not found. Install polkit or configure the interface manually.".to_string()
                } else {
                    format!("Failed to run pkexec: {}", e)
                }
            })?;

        if output.status.success() {
            eprintln!("[socketcan] Interface {} configured successfully", interface);
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);

            // Check for common error cases
            if stderr.contains("dismissed") || stderr.contains("cancelled") {
                Err("Authentication cancelled by user".to_string())
            } else if stderr.contains("Not authorized") {
                Err("Not authorised to configure network interfaces".to_string())
            } else {
                let error_detail = if !stderr.is_empty() {
                    stderr.trim().to_string()
                } else if !stdout.is_empty() {
                    stdout.trim().to_string()
                } else {
                    format!("Exit code: {:?}", output.status.code())
                };
                Err(format!("Failed to configure interface: {}", error_detail))
            }
        }
    }

    // ============================================================================
    // Utility Functions
    // ============================================================================

    /// Convert a CanAnyFrame to our FrameMessage format
    fn convert_any_frame(frame: CanAnyFrame, bus_override: Option<u8>) -> Option<FrameMessage> {
        match frame {
            CanAnyFrame::Normal(f) => Some(FrameMessage {
                protocol: "can".to_string(),
                timestamp_us: now_us(),
                frame_id: f.raw_id() & 0x1FFF_FFFF,
                bus: bus_override.unwrap_or(0),
                dlc: f.len() as u8,
                bytes: f.data().to_vec(),
                is_extended: f.is_extended(),
                is_fd: false,
                source_address: None,
                incomplete: None,
                direction: None,
            }),
            CanAnyFrame::Fd(f) => Some(FrameMessage {
                protocol: "can".to_string(),
                timestamp_us: now_us(),
                frame_id: f.raw_id() & 0x1FFF_FFFF,
                bus: bus_override.unwrap_or(0),
                dlc: f.len() as u8,
                bytes: f.data().to_vec(),
                is_extended: f.is_extended(),
                is_fd: true,
                source_address: None,
                incomplete: None,
                direction: None,
            }),
            CanAnyFrame::Remote(_) => None, // Skip remote frames
            CanAnyFrame::Error(_) => None,  // Skip error frames
        }
    }

    // ============================================================================
    // Simple SocketCAN Reader (for multi_source.rs)
    // ============================================================================

    /// Simple SocketCAN reader/writer for use in multi-source mode.
    /// Wraps a CanFdSocket for both reading and writing frames (supports CAN FD).
    pub struct SocketCanReader {
        socket: CanFdSocket,
    }

    impl SocketCanReader {
        /// Create a new SocketCAN reader for the given interface
        pub fn new(interface: &str) -> Result<Self, String> {
            let device = format!("socketcan({})", interface);
            let socket = CanFdSocket::open(interface)
                .map_err(|e| IoError::connection(&device, e.to_string()).to_string())?;

            // Set read timeout for non-blocking reads
            socket
                .set_read_timeout(Duration::from_millis(100))
                .map_err(|e| IoError::protocol(&device, format!("set read timeout: {}", e)).to_string())?;

            Ok(Self { socket })
        }

        /// Read a frame with timeout, returns None on timeout
        pub fn read_frame_timeout(&self, _timeout: Duration) -> Result<Option<FrameMessage>, String> {
            // Note: timeout is already set in constructor, parameter kept for API compatibility
            match self.socket.read_frame() {
                Ok(frame) => Ok(convert_any_frame(frame, None)),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => Ok(None),
                Err(e) => Err(format!("Read error: {}", e)),
            }
        }

        /// Write a CAN frame (classic or FD)
        pub fn write_frame(&self, data: &[u8], is_fd: bool) -> Result<(), String> {
            if is_fd {
                self.write_fd_frame(data)
            } else {
                self.write_classic_frame(data)
            }
        }

        /// Write a classic CAN frame (16-byte struct can_frame format)
        fn write_classic_frame(&self, data: &[u8]) -> Result<(), String> {
            if data.len() < 16 {
                return Err("Frame data too short".to_string());
            }

            // Parse struct can_frame layout: can_id (4), dlc (1), padding (3), data (8)
            let can_id = u32::from_ne_bytes([data[0], data[1], data[2], data[3]]);
            let dlc = data[4] as usize;
            let frame_data = &data[8..8 + dlc.min(8)];

            // Check flags in can_id
            let is_extended = (can_id & 0x8000_0000) != 0; // CAN_EFF_FLAG
            let raw_id = can_id & 0x1FFF_FFFF;

            // Build the frame
            let frame = if is_extended {
                let id = ExtendedId::new(raw_id)
                    .ok_or_else(|| format!("Invalid extended ID: 0x{:08X}", raw_id))?;
                CanDataFrame::new(Id::Extended(id), frame_data)
                    .ok_or_else(|| "Failed to create extended frame".to_string())?
            } else {
                let id = StandardId::new(raw_id as u16)
                    .ok_or_else(|| format!("Invalid standard ID: 0x{:03X}", raw_id))?;
                CanDataFrame::new(Id::Standard(id), frame_data)
                    .ok_or_else(|| "Failed to create standard frame".to_string())?
            };

            self.socket
                .write_frame(&frame)
                .map_err(|e| format!("Write error: {}", e))?;

            Ok(())
        }

        /// Write a CAN FD frame (72-byte struct canfd_frame format)
        fn write_fd_frame(&self, data: &[u8]) -> Result<(), String> {
            if data.len() < 72 {
                return Err("FD frame data too short".to_string());
            }

            // Parse struct canfd_frame layout: can_id (4), len (1), flags (1), padding (2), data (64)
            let can_id = u32::from_ne_bytes([data[0], data[1], data[2], data[3]]);
            let len = data[4] as usize;
            let frame_data = &data[8..8 + len.min(64)];

            // Check flags in can_id
            let is_extended = (can_id & 0x8000_0000) != 0; // CAN_EFF_FLAG
            let raw_id = can_id & 0x1FFF_FFFF;

            // Build the FD frame
            let frame = if is_extended {
                let id = ExtendedId::new(raw_id)
                    .ok_or_else(|| format!("Invalid extended ID: 0x{:08X}", raw_id))?;
                CanFdFrame::new(Id::Extended(id), frame_data)
                    .ok_or_else(|| "Failed to create extended FD frame".to_string())?
            } else {
                let id = StandardId::new(raw_id as u16)
                    .ok_or_else(|| format!("Invalid standard ID: 0x{:03X}", raw_id))?;
                CanFdFrame::new(Id::Standard(id), frame_data)
                    .ok_or_else(|| "Failed to create standard FD frame".to_string())?
            };

            self.socket
                .write_frame(&frame)
                .map_err(|e| format!("Write error: {}", e))?;

            Ok(())
        }
    }

    // ============================================================================
    // Multi-Source Streaming
    // ============================================================================

    /// Encoded frame result - either classic CAN (16 bytes) or CAN FD (72 bytes)
    pub enum EncodedFrame {
        Classic([u8; 16]),
        Fd([u8; 72]),
    }

    /// Encode a CAN frame for SocketCAN
    /// Returns Classic (16 bytes) for standard CAN or Fd (72 bytes) for CAN FD
    pub fn encode_frame(frame: &CanTransmitFrame) -> EncodedFrame {
        if frame.is_fd {
            encode_fd_frame(frame)
        } else {
            encode_classic_frame(frame)
        }
    }

    /// Encode a classic CAN frame (struct can_frame format, 16 bytes)
    fn encode_classic_frame(frame: &CanTransmitFrame) -> EncodedFrame {
        let mut buf = [0u8; 16];

        // can_id with flags
        let mut can_id = frame.frame_id;
        if frame.is_extended {
            can_id |= 0x8000_0000; // CAN_EFF_FLAG
        }
        if frame.is_rtr {
            can_id |= 0x4000_0000; // CAN_RTR_FLAG
        }

        buf[0..4].copy_from_slice(&can_id.to_ne_bytes());
        buf[4] = frame.data.len().min(8) as u8; // DLC
        // bytes 5-7 are padding

        // Data (up to 8 bytes)
        let len = frame.data.len().min(8);
        buf[8..8 + len].copy_from_slice(&frame.data[..len]);

        EncodedFrame::Classic(buf)
    }

    /// Encode a CAN FD frame (struct canfd_frame format, 72 bytes)
    fn encode_fd_frame(frame: &CanTransmitFrame) -> EncodedFrame {
        let mut buf = [0u8; 72];

        // can_id with flags
        let mut can_id = frame.frame_id;
        if frame.is_extended {
            can_id |= 0x8000_0000; // CAN_EFF_FLAG
        }

        buf[0..4].copy_from_slice(&can_id.to_ne_bytes());
        buf[4] = frame.data.len().min(64) as u8; // len
        // buf[5] = flags (CANFD_BRS, CANFD_ESI) - set BRS if requested
        if frame.is_brs {
            buf[5] |= 0x01; // CANFD_BRS
        }
        // bytes 6-7 are padding

        // Data (up to 64 bytes)
        let len = frame.data.len().min(64);
        buf[8..8 + len].copy_from_slice(&frame.data[..len]);

        EncodedFrame::Fd(buf)
    }

    /// Run SocketCAN source and send frames to merge task (supports CAN FD)
    ///
    /// If `bitrate` is provided, the interface will be configured automatically
    /// using pkexec before opening the socket.
    pub async fn run_source(
        source_idx: usize,
        interface: String,
        bitrate: Option<u32>,
        enable_fd: bool,
        data_bitrate: Option<u32>,
        bus_mappings: Vec<BusMapping>,
        stop_flag: Arc<AtomicBool>,
        tx: mpsc::Sender<SourceMessage>,
    ) {
        let device = format!("socketcan({})", interface);

        // Configure interface if bitrate is specified
        if let Some(br) = bitrate {
            if let Err(e) = configure_interface(&interface, br, enable_fd, data_bitrate) {
                let _ = tx
                    .send(SourceMessage::Error(source_idx, e))
                    .await;
                return;
            }
        }

        // Open FD socket (can read both classic CAN and CAN FD frames)
        let socket = match CanFdSocket::open(&interface) {
            Ok(s) => s,
            Err(e) => {
                let _ = tx
                    .send(SourceMessage::Error(
                        source_idx,
                        IoError::connection(&device, e.to_string()).to_string(),
                    ))
                    .await;
                return;
            }
        };

        // Set read timeout
        if let Err(e) = socket.set_read_timeout(Duration::from_millis(50)) {
            eprintln!("[socketcan] Warning: could not set read timeout: {}", e);
        }

        // Create transmit channel
        let (transmit_tx, transmit_rx) = std_mpsc::sync_channel::<TransmitRequest>(32);
        let _ = tx
            .send(SourceMessage::TransmitReady(source_idx, transmit_tx))
            .await;

        eprintln!(
            "[socketcan] Source {} connected to {} (FD capable)",
            source_idx, interface
        );

        // Emit device-connected event
        let _ = tx
            .send(SourceMessage::Connected(source_idx, "socketcan".to_string(), interface.clone(), None))
            .await;

        // Read loop (blocking)
        let tx_clone = tx.clone();
        let stop_flag_clone = stop_flag.clone();

        let blocking_handle = tokio::task::spawn_blocking(move || {
            while !stop_flag_clone.load(Ordering::Relaxed) {
                // Check for transmit requests
                while let Ok(req) = transmit_rx.try_recv() {
                    let result = transmit_frame(&socket, &req.data);
                    let _ = req.result_tx.send(result);
                }

                // Read frame (CanAnyFrame supports both classic and FD)
                match socket.read_frame() {
                    Ok(frame) => {
                        if let Some(mut frame_msg) = convert_any_frame(frame, None) {
                            if apply_bus_mapping(&mut frame_msg, &bus_mappings) {
                                let _ = tx_clone
                                    .blocking_send(SourceMessage::Frames(source_idx, vec![frame_msg]));
                            }
                        }
                    }
                    Err(ref e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut =>
                    {
                        // Timeout - continue
                    }
                    Err(e) => {
                        let _ = tx_clone.blocking_send(SourceMessage::Error(
                            source_idx,
                            format!("Read error: {}", e),
                        ));
                        return;
                    }
                }
            }

            let _ = tx_clone.blocking_send(SourceMessage::Ended(source_idx, "stopped".to_string()));
        });

        let _ = blocking_handle.await;
    }

    /// Transmit a frame via SocketCAN (handles both classic and FD)
    fn transmit_frame(socket: &CanFdSocket, data: &[u8]) -> Result<(), String> {
        // Determine if this is an FD frame based on data length
        // Classic CAN: 16 bytes, CAN FD: 72 bytes
        if data.len() >= 72 {
            // CAN FD frame
            let can_id = u32::from_ne_bytes([data[0], data[1], data[2], data[3]]);
            let len = data[4] as usize;
            let frame_data = &data[8..8 + len.min(64)];

            let is_extended = (can_id & 0x8000_0000) != 0;
            let raw_id = can_id & 0x1FFF_FFFF;

            let frame = if is_extended {
                let id = ExtendedId::new(raw_id)
                    .ok_or_else(|| format!("Invalid extended ID: 0x{:08X}", raw_id))?;
                CanFdFrame::new(Id::Extended(id), frame_data)
                    .ok_or_else(|| "Failed to create extended FD frame".to_string())?
            } else {
                let id = StandardId::new(raw_id as u16)
                    .ok_or_else(|| format!("Invalid standard ID: 0x{:03X}", raw_id))?;
                CanFdFrame::new(Id::Standard(id), frame_data)
                    .ok_or_else(|| "Failed to create standard FD frame".to_string())?
            };

            socket
                .write_frame(&frame)
                .map_err(|e| format!("Write error: {}", e))
        } else if data.len() >= 16 {
            // Classic CAN frame
            let can_id = u32::from_ne_bytes([data[0], data[1], data[2], data[3]]);
            let dlc = data[4] as usize;
            let frame_data = &data[8..8 + dlc.min(8)];

            let is_extended = (can_id & 0x8000_0000) != 0;
            let raw_id = can_id & 0x1FFF_FFFF;

            let frame = if is_extended {
                let id = ExtendedId::new(raw_id)
                    .ok_or_else(|| format!("Invalid extended ID: 0x{:08X}", raw_id))?;
                CanDataFrame::new(Id::Extended(id), frame_data)
                    .ok_or_else(|| "Failed to create extended frame".to_string())?
            } else {
                let id = StandardId::new(raw_id as u16)
                    .ok_or_else(|| format!("Invalid standard ID: 0x{:03X}", raw_id))?;
                CanDataFrame::new(Id::Standard(id), frame_data)
                    .ok_or_else(|| "Failed to create standard frame".to_string())?
            };

            socket
                .write_frame(&frame)
                .map_err(|e| format!("Write error: {}", e))
        } else {
            Err("Frame data too short".to_string())
        }
    }
}

// Re-export for Linux
#[cfg(target_os = "linux")]
pub use linux_impl::{
    encode_frame, run_source, EncodedFrame, SocketCanConfig, SocketCanReader,
};

// ============================================================================
// Non-Linux Stub
// ============================================================================

#[cfg(not(target_os = "linux"))]
#[allow(dead_code)]
mod stub {
    use serde::{Deserialize, Serialize};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    use crate::io::gvret::BusMapping;
    use crate::io::types::SourceMessage;
    use crate::io::CanTransmitFrame;

    /// SocketCAN configuration (stub for non-Linux)
    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub struct SocketCanConfig {
        pub interface: String,
        #[serde(default)]
        pub bitrate: Option<u32>,
        pub limit: Option<i64>,
        pub display_name: Option<String>,
        #[serde(default)]
        pub bus_override: Option<u8>,
        #[serde(default)]
        pub enable_fd: bool,
        #[serde(default)]
        pub data_bitrate: Option<u32>,
    }

    /// Encoded frame result - either classic CAN (16 bytes) or CAN FD (72 bytes)
    pub enum EncodedFrame {
        Classic([u8; 16]),
        Fd([u8; 72]),
    }

    /// Stub configure_interface for non-Linux
    pub fn configure_interface(
        _interface: &str,
        _bitrate: u32,
        _enable_fd: bool,
        _data_bitrate: Option<u32>,
    ) -> Result<(), String> {
        Err("SocketCAN is only available on Linux".to_string())
    }

    /// Stub encode_frame for non-Linux (not actually usable)
    pub fn encode_frame(frame: &CanTransmitFrame) -> EncodedFrame {
        if frame.is_fd {
            EncodedFrame::Fd([0u8; 72])
        } else {
            EncodedFrame::Classic([0u8; 16])
        }
    }

    /// Stub run_source for non-Linux
    pub async fn run_source(
        source_idx: usize,
        _interface: String,
        _bitrate: Option<u32>,
        _enable_fd: bool,
        _data_bitrate: Option<u32>,
        _bus_mappings: Vec<BusMapping>,
        _stop_flag: Arc<AtomicBool>,
        tx: mpsc::Sender<SourceMessage>,
    ) {
        let _ = tx
            .send(SourceMessage::Error(
                source_idx,
                "SocketCAN is only available on Linux".to_string(),
            ))
            .await;
    }
}

#[cfg(not(target_os = "linux"))]
#[allow(unused_imports)]
pub use stub::{
    configure_interface, encode_frame, run_source, EncodedFrame, SocketCanConfig,
};
