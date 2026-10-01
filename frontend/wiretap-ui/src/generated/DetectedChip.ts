// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Result returned to the frontend after a successful detection.
 *
 * `extra` carries the original chip-info struct (`EspChipInfo` or
 * `Stm32ChipInfo`) serialised as JSON, so the per-driver UI can display
 * extra fields (MAC for ESP, RDP level for STM32) without us having to
 * merge every variant into a single struct.
 */
export type DetectedChip = { 
/**
 * Driver registry id on the frontend (`"esp-uart"` | `"stm32-uart"`).
 */
driver_id: string, 
/**
 * Manufacturer badge string (`"ESP32"` | `"ESP8266"` | `"STM32"`).
 */
manufacturer: string, 
/**
 * Friendly chip name (`"ESP32-S3"`, `"STM32F103"`, …).
 */
chip_name: string, 
/**
 * Flash size in KB if known, else `None`.
 */
flash_size_kb: number | null, 
/**
 * Original chip-info struct so per-driver UIs can render extra fields.
 */
extra: unknown, };
