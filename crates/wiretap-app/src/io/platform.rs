// Copyright 2026 Wired Square Pty Ltd

//! Serial and slcan commands that answer on every platform: the real thing on
//! desktop, a stub on iOS, where the serial and slcan modules do not build.

/// Serial port info (duplicated for iOS compatibility)
#[derive(Clone, serde::Serialize)]
pub struct SerialPortInfoCompat {
    pub port_name: String,
    pub port_type: String,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

/// slcan probe result (duplicated for iOS compatibility)
#[derive(Clone, serde::Serialize)]
pub struct SlcanProbeResultCompat {
    pub success: bool,
    pub version: Option<String>,
    pub hardware_version: Option<String>,
    pub serial_number: Option<String>,
    pub supports_fd: Option<bool>,
    pub error: Option<String>,
}

impl SlcanProbeResultCompat {
    fn failed(error: String) -> Self {
        Self {
            success: false,
            version: None,
            hardware_version: None,
            serial_number: None,
            supports_fd: None,
            error: Some(error),
        }
    }
}

/// List serial ports - returns empty on iOS, real list on desktop
/// Named with platform_ prefix to avoid macro name collision with io::serial::reader::list_serial_ports
#[tauri::command(rename_all = "snake_case")]
pub fn platform_list_serial_ports() -> Result<Vec<SerialPortInfoCompat>, String> {
    #[cfg(not(target_os = "ios"))]
    {
        super::serial::reader::list_serial_ports().map(|ports| {
            ports.into_iter().map(|p| SerialPortInfoCompat {
                port_name: p.port_name,
                port_type: p.port_type,
                manufacturer: p.manufacturer,
                product: p.product,
                serial_number: p.serial_number,
                vid: p.vid,
                pid: p.pid,
            }).collect()
        })
    }
    #[cfg(target_os = "ios")]
    {
        Ok(vec![])
    }
}

/// Probe slcan device - not supported on iOS
#[tauri::command(rename_all = "snake_case")]
pub async fn platform_probe_slcan_device(
    port: String,
    baud_rate: u32,
    data_bits: Option<u8>,
    stop_bits: Option<u8>,
    parity: Option<String>,
) -> SlcanProbeResultCompat {
    #[cfg(not(target_os = "ios"))]
    {
        let parsed = wiretap_io::serial::LineSettings::parse(
            baud_rate,
            data_bits,
            stop_bits,
            parity.as_deref(),
        );
        let line = match parsed {
            Ok(line) => line,
            Err(e) => return SlcanProbeResultCompat::failed(e.to_string()),
        };
        let result = super::slcan::reader::probe_slcan(&port, line).await;
        SlcanProbeResultCompat {
            success: result.success,
            version: result.version,
            hardware_version: result.hardware_version,
            serial_number: result.serial_number,
            supports_fd: result.supports_fd,
            error: result.error,
        }
    }
    #[cfg(target_os = "ios")]
    {
        let _ = (port, baud_rate, data_bits, stop_bits, parity);
        SlcanProbeResultCompat::failed("Serial ports are not available on iOS".to_string())
    }
}
