// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Flasher tuning passed in from the UI. Every field is optional — `None`
 * means "let espflash decide / leave at its default". Mirrors the knobs on
 * the `esptool ... write-flash` command line.
 */
export type EspFlashOptions = { 
/**
 * Forced chip type (`esp32`, `esp32s3`, …). `None` = auto-detect.
 */
chip?: string | null, 
/**
 * Bootloader baud rate. `None` defaults to 921_600.
 */
flash_baud?: number | null, 
/**
 * Flash mode (`dio`, `qio`, `qout`, `dout`).
 */
flash_mode?: string | null, 
/**
 * Flash frequency (`40MHz`, `80MHz`, `26MHz`, `20MHz`).
 */
flash_freq?: string | null, 
/**
 * Flash size (`4MB`, `8MB`, `16MB`, …).
 */
flash_size?: string | null, };
