//! Unified chip-family detection across all serial-port flashers.
//!
//! Probes the connected port in a deterministic order — STM32 AN3155 first
//! (single 0x7F + ACK, fast and unambiguous), then ESP esptool (slip sync).
//! The first protocol that responds wins. Returns a `DetectedChip` payload
//! the frontend uses to pick a driver and pre-fill chip metadata.
//!
//! Detection re-uses the existing `esp_flasher::detect_chip` and
//! `stm32_flasher::detect_chip` functions, so anything either of those
//! flashers can identify, this command can identify too. Adding a new
//! serial-bus flasher = adding one more probe step here.

use serde::Serialize;
use serde_json::Value;

use super::{esp_flasher, stm32_flasher, EspChipInfo, Stm32ChipInfo, Stm32FlashOptions};

/// Result returned to the frontend after a successful detection.
///
/// `extra` carries the original chip-info struct (`EspChipInfo` or
/// `Stm32ChipInfo`) serialised as JSON, so the per-driver UI can display
/// extra fields (MAC for ESP, RDP level for STM32) without us having to
/// merge every variant into a single struct.
#[derive(Clone, Serialize, Debug)]
pub struct DetectedChip {
    /// Driver registry id on the frontend (`"esp-uart"` | `"stm32-uart"`).
    pub driver_id: String,
    /// Manufacturer badge string (`"ESP32"` | `"ESP8266"` | `"STM32"`).
    pub manufacturer: String,
    /// Friendly chip name (`"ESP32-S3"`, `"STM32F103"`, …).
    pub chip_name: String,
    /// Flash size in KB if known, else `None`.
    pub flash_size_kb: Option<u32>,
    /// Original chip-info struct so per-driver UIs can render extra fields.
    pub extra: Value,
}

/// Probe `port` for any supported chip family. Tries STM32 first because the
/// 0x7F sync is a single-byte handshake with a tight timeout — fast on a
/// non-STM32 board. Falls through to ESP if STM32 doesn't ACK.
///
/// `stm32_options` lets the caller pass through their RTS/DTR pin mapping
/// so detection uses the same bootloader-entry sequence the user has
/// already configured for their board. Defaults work for stm32flash-style
/// wiring (DTR=BOOT0, RTS=NRST).
pub async fn detect(
    port: String,
    stm32_options: Stm32FlashOptions,
) -> Result<DetectedChip, String> {
    let stm32_err = match stm32_flasher::detect_chip(port.clone(), stm32_options).await {
        Ok(info) => return Ok(stm32_to_detected(info)),
        Err(e) => e,
    };

    let esp_err = match esp_flasher::detect_chip(port.clone(), Default::default()).await {
        Ok(info) => return Ok(esp_to_detected(info)),
        Err(e) => e,
    };

    Err(format!(
        "Could not identify chip on {port}.\nSTM32 (AN3155): {stm32_err}\nESP (esptool): {esp_err}"
    ))
}

fn stm32_to_detected(info: Stm32ChipInfo) -> DetectedChip {
    let chip_name = info.chip.clone();
    let flash_size_kb = info.flash_size_kb;
    DetectedChip {
        driver_id: "stm32-uart".to_string(),
        manufacturer: "STM32".to_string(),
        chip_name,
        flash_size_kb,
        extra: serde_json::to_value(&info).unwrap_or(Value::Null),
    }
}

fn esp_to_detected(info: EspChipInfo) -> DetectedChip {
    // ESP8266 reports as `"esp8266"` from espflash; everything else in the
    // `esp32*` family lives under the ESP32 badge.
    let manufacturer = if info.chip.eq_ignore_ascii_case("esp8266") {
        "ESP8266".to_string()
    } else {
        "ESP32".to_string()
    };
    let chip_name = pretty_esp_chip(&info.chip);
    let flash_size_kb = info.flash_size_bytes.map(|b| (b / 1024) as u32);
    DetectedChip {
        driver_id: "esp-uart".to_string(),
        manufacturer,
        chip_name,
        flash_size_kb,
        extra: serde_json::to_value(&info).unwrap_or(Value::Null),
    }
}

/// `"esp32s3"` → `"ESP32-S3"`, `"esp32"` → `"ESP32"`, `"esp8266"` → `"ESP8266"`.
fn pretty_esp_chip(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower == "esp8266" {
        return "ESP8266".to_string();
    }
    if let Some(suffix) = lower.strip_prefix("esp32") {
        if suffix.is_empty() {
            return "ESP32".to_string();
        }
        return format!("ESP32-{}", suffix.to_ascii_uppercase());
    }
    raw.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pretty_esp_chip_handles_known_variants() {
        assert_eq!(pretty_esp_chip("esp32"), "ESP32");
        assert_eq!(pretty_esp_chip("esp32s3"), "ESP32-S3");
        assert_eq!(pretty_esp_chip("esp32c6"), "ESP32-C6");
        assert_eq!(pretty_esp_chip("esp32c61"), "ESP32-C61");
        assert_eq!(pretty_esp_chip("esp8266"), "ESP8266");
        // Unknown chip strings pass through untouched.
        assert_eq!(pretty_esp_chip("foobar"), "foobar");
    }
}
