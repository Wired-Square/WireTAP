// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Tuning knobs for the STM32 UART flasher. Pin mapping models the
 * stm32flash-style convention (DTR=BOOT0, RTS=NRST) but is fully
 * configurable for boards that wire it differently — the `"none"` setting
 * disables drive of that line, leaving the user to enter the bootloader
 * manually.
 */
export type Stm32FlashOptions = { 
/**
 * Pin driving BOOT0. `"rts"` | `"dtr"` | `"none"`. Default `"dtr"`.
 */
boot0_pin?: string | null, 
/**
 * Pin driving NRST. `"rts"` | `"dtr"` | `"none"`. Default `"rts"`.
 */
reset_pin?: string | null, 
/**
 * Invert BOOT0 polarity. Default `false` (asserted high = bootloader).
 */
boot0_invert?: boolean | null, 
/**
 * Invert RESET polarity. Default `true` (active-low NRST through an RC).
 */
reset_invert?: boolean | null, 
/**
 * Bootloader baud (1200..=115200 per AN3155). Default 115_200.
 */
baud?: number | null, };
